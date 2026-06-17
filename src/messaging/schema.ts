import type { SolanaSignMessageInput, SolanaSignTransactionInput } from '@solana/wallet-standard-features'
import type { StandardConnectInput } from '@wallet-standard/core'

import type { TransportConnectOutput, TransportSignMessageOutput, TransportSignTransactionOutput } from './transport.ts'

export interface MessagingSchema {
  connect(input?: StandardConnectInput): Promise<TransportConnectOutput>
  disconnect(): Promise<void>
  // Variadic SolanaSignMessageMethod collapsed to ONE array payload: @webext-core GetDataType
  // only accepts handlers with 0|1 args. The page-realm feature does the rest-param collapse.
  signMessage(inputs: SolanaSignMessageInput[]): Promise<TransportSignMessageOutput[]>
  signTransaction(inputs: SolanaSignTransactionInput[]): Promise<TransportSignTransactionOutput[]>
}
