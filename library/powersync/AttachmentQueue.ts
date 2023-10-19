import { AbstractPowerSyncDatabase, Transaction } from '@journeyapps/powersync-sdk-react-native';
import * as FileSystem from 'expo-file-system';
import { v4 as uuid } from 'uuid';
import { ATTACHMENT_TABLE, AttachmentRecord, AttachmentState } from './AppSchema';
import { AbstractStorageAdapter, UploadOptions } from '../storage/AbstractStorageAdapter';

export const ATTACHMENT_LOCAL_STORAGE_KEY = 'attachments';
export const ATTACHMENT_STORAGE_PATH = `${FileSystem.documentDirectory}${ATTACHMENT_LOCAL_STORAGE_KEY}`;
export const ATTACHMENT_QUEUE_INTERVAL = 60_000;
export const ATTACHMENT_CACHE_LIMIT = 100;

export interface AttachmentQueueOptions {
  powersync: AbstractPowerSyncDatabase;
  storage: AbstractStorageAdapter;
  getAttachmentIds?: () => Promise<string[]>;
  syncInterval?: number;
  cacheLimit?: number;
}

export class AttachmentQueue {
  uploading: boolean;
  downloading: boolean;
  options: AttachmentQueueOptions;

  constructor(options: AttachmentQueueOptions) {
    this.uploading = false;
    this.downloading = false;
    this.options = {
      ...options,
      syncInterval: options.syncInterval ?? ATTACHMENT_QUEUE_INTERVAL,
      cacheLimit: options.cacheLimit ?? ATTACHMENT_CACHE_LIMIT
    };
  }

  protected get powersync() {
    return this.options.powersync;
  }

  protected get storage() {
    return this.options.storage;
  }

  get table() {
    return ATTACHMENT_TABLE;
  }

  async init() {
    // Ensure attachment directory exists
    await this.storage.makeDir(ATTACHMENT_STORAGE_PATH);

    const attachmentIds = (await this.options.getAttachmentIds?.()) || [];
    if (attachmentIds.length > 0) {
      await this.markForSync(attachmentIds);
    }

    this.watchUploads();
    this.watchDownloads();

    setInterval(() => this.trigger(), ATTACHMENT_QUEUE_INTERVAL);
  }

  trigger() {
    this.uploadRecords();
    this.downloadRecords();
    this.expireCache();
  }

  async getAttachmentRecord(id: string): Promise<AttachmentRecord | null> {
    return this.powersync.getOptional<AttachmentRecord>(`SELECT * FROM ${this.table} WHERE id = ?`, [id]);
  }

  async savePhoto(base64Data: string): Promise<AttachmentRecord> {
    const photoAttachment = this.newPhotoRecord();
    await this.storage.writeFile(photoAttachment.local_uri!, base64Data, { encoding: FileSystem.EncodingType.Base64 });

    const fileInfo = await FileSystem.getInfoAsync(photoAttachment.local_uri!);
    if (fileInfo.exists) {
      photoAttachment.size = fileInfo.size;
    }

    return this.saveToQueue(photoAttachment);
  }

  async saveToQueue(record: Omit<AttachmentRecord, 'timestamp'>): Promise<AttachmentRecord> {
    const updatedRecord: AttachmentRecord = {
      ...record,
      timestamp: new Date().getTime()
    };

    await this.powersync.execute(
      `INSERT OR REPLACE INTO ${this.table} (id, timestamp, filename, local_uri, media_type, size, state) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        updatedRecord.id,
        updatedRecord.timestamp,
        updatedRecord.filename,
        updatedRecord.local_uri || null,
        updatedRecord.media_type || null,
        updatedRecord.size || null,
        updatedRecord.state
      ]
    );

    return updatedRecord;
  }

  async update(record: Omit<AttachmentRecord, 'timestamp'>): Promise<void> {
    const timestamp = new Date().getTime();
    await this.powersync.execute(
      `UPDATE ${this.table}
             SET 
                timestamp = ?,
                filename = ?,
                local_uri = ?,
                size = ?,
                media_type = ?,
                state = ?
             WHERE id = ?`,
      [timestamp, record.filename, record.local_uri || null, record.size, record.media_type, record.state, record.id]
    );
  }

  async markForSync(ids: string[]): Promise<void> {
    if (ids.length > 0) {
      // Mark attachments for sync
      await this.powersync.execute(
        `UPDATE ${this.table} SET state = ${AttachmentState.QUEUED_SYNC} WHERE id IN (${ids
          .map((id) => `'${id}'`)
          .join(',')})`
      );
    }
  }

  async delete(record: AttachmentRecord, tx?: Transaction): Promise<void> {
    const deleteRecord = async (tx: Transaction) => {
      await tx.executeAsync(
        `DELETE
             FROM ${this.table}
             WHERE id = ?`,
        [record.id]
      );
    };

    if (tx) {
      await deleteRecord(tx);
    } else {
      await this.powersync.writeTransaction(deleteRecord);
    }
    // Delete file on storage
    return this.storage.deleteFile(record.filename, record.local_uri || this.getLocalUri(record.filename));
  }

  async getNextUploadRecord(): Promise<AttachmentRecord | null> {
    return this.powersync.getOptional<AttachmentRecord>(
      `SELECT *
                FROM ${this.table}
                WHERE
                  local_uri IS NOT NULL
                AND
                  (state = ${AttachmentState.QUEUED_UPLOAD}
                OR
                  state = ${AttachmentState.QUEUED_SYNC})
                ORDER BY timestamp ASC`
    );
  }

  async getNextDownloadRecords(): Promise<AttachmentRecord[]> {
    return this.powersync.getAll<AttachmentRecord>(
      `SELECT *
                FROM ${this.table} 
                WHERE
                  state = ${AttachmentState.QUEUED_DOWNLOAD} 
                OR
                  state = ${AttachmentState.QUEUED_SYNC}
                ORDER BY timestamp ASC`
    );
  }

  async uploadAttachment(record: AttachmentRecord) {
    if (!record.local_uri) {
      throw new Error(`No local_uri for record ${JSON.stringify(record, null, 2)}`);
    }
    try {
      const fileBuffer = await this.storage.readFile(record.local_uri, {
        encoding: FileSystem.EncodingType.Base64,
        mediaType: record.media_type
      });

      const options: UploadOptions = {};
      if (record.media_type) {
        options.mediaType = record.media_type;
      }

      await this.storage.uploadFile(record.filename, fileBuffer, options);
      // Mark as uploaded
      await this.update({ ...record, state: AttachmentState.SYNCED });
      console.debug(`Uploaded attachment "${record.id}" to Cloud Storage`);
      return true;
    } catch (e: any) {
      if (e.error == 'Duplicate') {
        console.log(`File already uploaded, marking ${record.id} as synced`);
        await this.update({ ...record, state: AttachmentState.SYNCED });
        return false;
      }
      console.error(`UploadAttachment error for record ${JSON.stringify(record, null, 2)}`, e);
      return false;
    }
  }

  async downloadRecord(record: AttachmentRecord) {
    if (!record.local_uri) {
      record.local_uri = this.getLocalUri(record.filename);
    }
    if (await this.storage.fileExists(record.local_uri)) {
      console.debug(`Local file already downloaded, marking "${record.id}" as synced`);
      await this.update({ ...record, state: AttachmentState.SYNCED });
      return true;
    }

    try {
      const fileBlob = await this.storage.downloadFile(record.filename);

      // Convert the blob data into a base64 string
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          // remove the header from the result: 'data:*/*;base64,'
          resolve(reader.result?.toString().replace(/^data:.+;base64,/, '') || '');
        };
        reader.onerror = reject;
        reader.readAsDataURL(fileBlob);
      });

      // Ensure directory exists
      await this.storage.makeDir(record.local_uri.replace(record.filename, ''));
      // Write the file
      await this.storage.writeFile(record.local_uri, base64Data, { encoding: FileSystem.EncodingType.Base64 });

      await this.update({ ...record, media_type: fileBlob.type, state: AttachmentState.SYNCED });
      console.debug(`Downloaded attachment "${record.id}"`);
      return true;
    } catch (e) {
      console.error(`Download attachment error for record ${JSON.stringify(record, null, 2)}`, e);
    }
    return false;
  }

  async *idsToUpload(): AsyncIterable<string[]> {
    for await (const result of this.powersync.watch(
      `SELECT id
              FROM ${this.table} 
              WHERE
                local_uri IS NOT NULL
              AND
                (state = ${AttachmentState.QUEUED_UPLOAD} 
              OR
                state = ${AttachmentState.QUEUED_SYNC})`,
      []
    )) {
      yield result.rows?._array.map((r) => r.id) || [];
    }
  }

  async watchUploads() {
    for await (const ids of this.idsToUpload()) {
      if (ids.length > 0) {
        await this.uploadRecords();
      }
    }
  }

  /**
   * Returns immediately if another loop is in progress.
   */
  private async uploadRecords() {
    if (this.uploading) {
      return;
    }
    this.uploading = true;
    try {
      let record = await this.getNextUploadRecord();
      if (!record) {
        return;
      }
      console.debug(`Uploading attachments...`);
      while (record) {
        const uploaded = await this.uploadAttachment(record);
        if (!uploaded) {
          // TODO: we need to retry
          break;
        }
        record = await this.getNextUploadRecord();
      }
      console.debug('Finished uploading attachments');
    } catch (error) {
      console.error('Upload failed:', error);
    } finally {
      this.uploading = false;
    }
  }

  async *idsToDownload(): AsyncIterable<string[]> {
    for await (const result of this.powersync.watch(
      `SELECT id
              FROM ${this.table} 
              WHERE 
                state = ${AttachmentState.QUEUED_DOWNLOAD} 
              OR 
                state = ${AttachmentState.QUEUED_SYNC}`,
      []
    )) {
      yield result.rows?._array.map((r) => r.id) || [];
    }
  }

  async watchDownloads() {
    for await (const ids of this.idsToDownload()) {
      if (ids.length > 0) {
        await this.downloadRecords();
      }
    }
  }

  private async downloadRecords() {
    if (this.downloading) {
      return;
    }
    this.downloading = true;
    try {
      const recordsToDownload = await this.getNextDownloadRecords();
      if (recordsToDownload.length == 0) {
        return;
      }
      console.debug(`Downloading ${recordsToDownload.length} attachments...`);
      for (const record of recordsToDownload) {
        await this.downloadRecord(record);
      }
      console.debug('Finished downloading attachments');
    } catch (e) {
      console.error('Downloads failed:', e);
    } finally {
      this.downloading = false;
    }
  }

  getLocalUri(filename: string): string {
    return `${ATTACHMENT_STORAGE_PATH}/${filename}`;
  }

  newPhotoRecord(record?: Partial<AttachmentRecord>): AttachmentRecord {
    const photoId = record?.id ?? uuid();
    const filename = record?.filename ?? `${photoId}.jpg`;
    return {
      id: photoId,
      filename,
      media_type: 'image/jpeg',
      local_uri: this.getLocalUri(filename),
      state: AttachmentState.QUEUED_UPLOAD,
      ...record
    };
  }

  async expireCache() {
    const res = await this.powersync.getAll<AttachmentRecord>(`SELECT * FROM ${this.table} 
          WHERE 
           state = ${AttachmentState.SYNCED}
         ORDER BY 
           timestamp DESC
         LIMIT 100 OFFSET ${this.options.cacheLimit}`);

    if (res.length == 0) {
      return;
    }

    console.debug(`Deleting ${res.length} attachments from cache...`);
    await this.powersync.writeTransaction(async (tx) => {
      for (const record of res) {
        await this.delete(record, tx);
      }
    });
  }

  clearQueue(): Promise<void> {
    return this.powersync.writeTransaction(async (tx) => {
      await tx.executeAsync(
        `DELETE
             FROM ${this.table}`
      );
    });
  }
}