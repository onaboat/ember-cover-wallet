import type { SolanaSignMessageInput, SolanaSignTransactionInput } from '@solana/wallet-standard-features'
import type { StandardConnectInput } from '@wallet-standard/core'

import type {
  TransportConnectOutput,
  TransportSignMessageOutput,
  TransportSignTransactionOutput,
} from '../messaging/transport.ts'
import { requestService } from './request-service.ts'

export async function connect(
  input: StandardConnectInput | undefined,
  origin?: string,
): Promise<TransportConnectOutput> {
  return await requestService().create('connect', input, origin)
}

export async function disconnect(): Promise<void> {
  // Stateless in this slice: the dapp clears its own accounts; the SW holds no session yet.
}

export async function signMessage(
  inputs: SolanaSignMessageInput[],
  origin?: string,
): Promise<TransportSignMessageOutput[]> {
  return await requestService().create('signMessage', inputs, origin)
}

export async function signTransaction(
  inputs: SolanaSignTransactionInput[],
  origin?: string,
): Promise<TransportSignTransactionOutput[]> {
  return await requestService().create('signTransaction', inputs, origin)
}
