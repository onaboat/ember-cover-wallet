import type { SolanaSignMessageOutput, SolanaSignTransactionOutput } from '@solana/wallet-standard-features'
import type { WalletAccount } from '@wallet-standard/core'

/** A Uint8Array after extension-messaging serialization. */
export type TransportBytes = Record<string, number>

/** WalletAccount as it arrives over the wire: publicKey is a serialized byte record. */
export type TransportWalletAccount = Omit<WalletAccount, 'publicKey'> & { publicKey: TransportBytes }

/** SolanaSignMessageOutput over the wire: both byte fields are serialized records. */
export type TransportSignMessageOutput = Omit<SolanaSignMessageOutput, 'signature' | 'signedMessage'> & {
  signature: TransportBytes
  signedMessage: TransportBytes
}

/** SolanaSignTransactionOutput over the wire: signedTransaction is a serialized byte record. */
export type TransportSignTransactionOutput = Omit<SolanaSignTransactionOutput, 'signedTransaction'> & {
  signedTransaction: TransportBytes
}

export interface TransportConnectOutput {
  accounts: TransportWalletAccount[]
}
