import type { SolanaSignMessageInput, SolanaSignMessageOutput } from '@solana/wallet-standard-features'

import { decodeTransportBytes } from '../messaging/transport-bytes.ts'

/**
 * Turns approved inputs + a signer into wallet-standard outputs. CRITICAL: input.message has
 * crossed >=1 serialization hop and is a {0:n,...} record at runtime — decodeTransportBytes it,
 * NOT new Uint8Array(input.message) (which would sign garbage).
 */
export async function buildSignMessageOutputs(
  inputs: SolanaSignMessageInput[],
  sign: (message: Uint8Array) => Promise<Uint8Array>,
  address: string,
): Promise<SolanaSignMessageOutput[]> {
  const outputs: SolanaSignMessageOutput[] = []
  for (const input of inputs) {
    if (!input.account || input.account.address !== address) {
      throw new Error('Account does not match vault')
    }
    const message = decodeTransportBytes(input.message)
    const signature = await sign(message)
    outputs.push({ signedMessage: message, signature })
  }
  return outputs
}
