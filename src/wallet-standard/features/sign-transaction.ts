import type { SolanaSignTransactionInput, SolanaSignTransactionOutput } from '@solana/wallet-standard-features'

import { decodeTransportBytes } from '../../messaging/transport-bytes.ts'
import { sendMessage } from '../../messaging/window.ts'

export async function signTransaction(...inputs: SolanaSignTransactionInput[]): Promise<SolanaSignTransactionOutput[]> {
  const outputs = await sendMessage('signTransaction', inputs)
  return outputs.map((output) => ({
    ...output,
    signedTransaction: decodeTransportBytes(output.signedTransaction),
  }))
}
