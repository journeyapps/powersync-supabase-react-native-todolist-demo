import * as FileSystem from 'expo-file-system';
import { v4 as uuid } from 'uuid';
import { AppConfig } from '../supabase/AppConfig';
import {
  AbstractAttachmentQueue,
  AttachmentRecord,
  AttachmentState,
  EncodingType
} from '@journeyapps/powersync-attachments';
import { TODO_TABLE } from './AppSchema';

export class PhotoAttachmentQueue extends AbstractAttachmentQueue {
  async init() {
    if (!AppConfig.supabaseBucket) {
      console.debug('No Supabase bucket configured, skip setting up PhotoAttachmentQueue watches');
      // Disable sync interval to prevent errors from trying to sync to a non-existent bucket
      this.options.syncInterval = 0;
      return;
    }

    await super.init();
  }

  async *attachmentIds(): AsyncIterable<string[]> {
    for await (const result of this.powersync.watch(
      `SELECT photo_id as id FROM ${TODO_TABLE} WHERE photo_id IS NOT NULL`,
      []
    )) {
      yield result.rows?._array.map((r) => r.id) ?? [];
    }
  }

  async newAttachmentRecord(record?: Partial<AttachmentRecord>): Promise<AttachmentRecord> {
    const photoId = record?.id ?? uuid();
    const filename = record?.filename ?? `${photoId}.jpg`;
    return {
      id: photoId,
      filename,
      media_type: 'image/jpeg',
      state: AttachmentState.QUEUED_UPLOAD,
      ...record
    };
  }

  async savePhoto(base64Data: string): Promise<AttachmentRecord> {
    const photoAttachment = await this.newAttachmentRecord();
    photoAttachment.local_uri = this.getLocalFilePathSuffix(photoAttachment.filename);
    const localUri = this.getLocalUri(photoAttachment.local_uri);
    await this.storage.writeFile(localUri, base64Data, { encoding: FileSystem.EncodingType.Base64 });

    const fileInfo = await FileSystem.getInfoAsync(localUri);
    if (fileInfo.exists) {
      photoAttachment.size = fileInfo.size;
    }

    return this.saveToQueue(photoAttachment);
  }
}
