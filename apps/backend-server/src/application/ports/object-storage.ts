/**
 * 原本の保存先（仕様書 15.4）。
 *
 * 原本は Cloud Storage、メタデータと hash と版は Firestore に分ける。
 * Web へ Storage の資格情報を渡さず、取得は毎回 Backend が権限を検証する。
 */
export interface StoredObject {
  content: Uint8Array
  contentType: string
}

export interface ObjectStorage {
  put(key: string, content: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<StoredObject | null>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}
