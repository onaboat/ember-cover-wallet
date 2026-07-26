import type { SolanaSignMessageInput, SolanaSignTransactionInput } from '@solana/wallet-standard-features'
import type { StandardConnectInput } from '@wallet-standard/core'

import type {
  TransportConnectOutput,
  TransportSignMessageOutput,
  TransportSignTransactionOutput,
} from '../messaging/transport.ts'
import { buildConnectAccount } from './build-account.ts'
import { dappConnections } from './dapp-connections.ts'
import { requestService } from './request-service.ts'
import { walletClusterForChain } from '../wallet-standard/chains.ts'

function connectedAccount(address: string): TransportConnectOutput {
  return { accounts: [buildConnectAccount(address)] } as unknown as TransportConnectOutput
}

export async function connect(
  input: StandardConnectInput | undefined,
  origin?: string,
): Promise<TransportConnectOutput> {
  if (input?.silent) {
    const address = await requestService().currentAddress()
    const connection = origin ? await dappConnections.get(origin, address) : null
    return connection ? connectedAccount(connection.address) : { accounts: [] }
  }

  const output = await requestService().create('connect', input, origin)
  const address = output.accounts[0]?.address
  if (origin && address) {
    await dappConnections.authorize(origin, address)
  }
  return output
}

export async function disconnect(origin?: string): Promise<void> {
  if (origin) {
    await dappConnections.disconnect(origin)
  }
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
  for (const input of inputs) {
    walletClusterForChain(input.chain)
  }
  return await requestService().create('signTransaction', inputs, origin)
}
