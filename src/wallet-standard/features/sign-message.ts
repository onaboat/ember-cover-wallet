import type { SolanaSignMessageInput, SolanaSignMessageOutput } from '@solana/wallet-standard-features'

import { decodeTransportBytes } from '../../messaging/transport-bytes.ts'
import { sendMessage } from '../../messaging/window.ts'

export async function signMessage(...inputs: SolanaSignMessageInput[]): Promise<SolanaSignMessageOutput[]> {
  // Wallet-standard passes rest-params; we send them as a single array (messaging arity rule).
  const outputs = await sendMessage('signMessage', inputs)
  return outputs.map((output) => ({
    ...output,
    signature: decodeTransportBytes(output.signature),
    signedMessage: decodeTransportBytes(output.signedMessage),
  }))
}
