export interface Argon2Params {
  m: number
  t: number
  p: number
}

export interface VaultRecord {
  /** base64 */
  salt: string
  argon2Params: Argon2Params
  /** base64 */
  iv: string
  /** base64 */
  ciphertext: string
  /** base58 address */
  publicKey: string
}

export interface VaultStore {
  get(): Promise<VaultRecord | null>
  put(record: VaultRecord): Promise<void>
  clear(): Promise<void>
}
