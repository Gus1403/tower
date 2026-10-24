// Upload storage (worker BS2 replaces this stub). BS1 resolves prompt attachments through getUpload().
export interface StoredUpload {
  id: string;
  name: string; // sanitized basename
  path: string; // absolute path of the stored bytes
  size: number;
}

export function getUpload(_id: string): StoredUpload | undefined {
  return undefined;
}
