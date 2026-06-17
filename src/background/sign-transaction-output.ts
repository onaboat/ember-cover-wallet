import { getTransactionDecoder, getTransactionEncoder } from '@solana/kit'
import type { Address, SignatureBytes } from '@solana/kit'
import type { SolanaSignTransactionInput, SolanaSignTransactionOutput } from '@solana/wallet-standard-features'

import { decodeTransportBytes } from '../messaging/transport-bytes.ts'

/**
 * Signs each transaction by signing its messageBytes with the vault key and placing the signature
 * into the signatures map keyed by the signer address. No CryptoKeyPair, no RPC (send is separate).
 * input.transaction arrived over >=1 serialization hop -> decodeTransportBytes first.
 */
export async function buildSignTransactionOutputs(
  inputs: SolanaSignTransactionInput[],
  sign: (message: Uint8Array) => Promise<Uint8Array>,
  address: string,
): Promise<SolanaSignTransactionOutput[]> {
  const decoder = getTransactionDecoder()
  const encoder = getTransactionEncoder()
  const outputs: SolanaSignTransactionOutput[] = []
  for (const input of inputs) {
    const tx = decoder.decode(decodeTransportBytes(input.transaction))
    const signature = (await sign(new Uint8Array(tx.messageBytes))) as SignatureBytes
    const signed = { ...tx, signatures: { ...tx.signatures, [address as Address]: signature } }
    outputs.push({ signedTransaction: new Uint8Array(encoder.encode(signed)) })
  }
  return outputs
}
