export type OperatorJob =
  | Readonly<{
      id: string
      kind: 'sign_message'
      messageBase64: string
      summary: Readonly<{
        messageSha256: string
        title: string
        walletAddress: string
      }>
    }>
  | Readonly<{
      id: string
      kind: 'sign_transaction'
      summary: Readonly<{
        amount: string
        asset: string
        cluster: 'devnet'
        feeLamports: string
        feePayer: string
        recipient: string
        simulation: 'passed'
        title: string
        transactionSha256: string
      }>
      transactionBase64: string
    }>

type WithoutId<Job> = Job extends { id: string } ? Omit<Job, 'id'> : never

export type OperatorJobInput = WithoutId<OperatorJob>

export type OperatorResult =
  | Readonly<{
      id: string
      outcome: 'rejected'
      reason: string
    }>
  | Readonly<{
      id: string
      outcome: 'signed_message'
      signatureBase64: string
      signedMessageBase64: string
      walletAddress: string
    }>
  | Readonly<{
      id: string
      outcome: 'signed_transaction'
      signedTransactionBase64: string
      walletAddress: string
    }>

export interface OperatorState {
  connectedWallet: string | null
  job: OperatorJob | null
  walletName: string
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
