import { simulationSigningBlock } from './simulation-signing-facts.ts'
import type { SigningDisposition } from '../signing/signing-policy.ts'
import { signingPolicyMessage } from '../signing/signing-policy.ts'
import { createSolanaRpc, getBase64EncodedWireTransaction, getTransactionDecoder } from '@solana/kit'
import type { Base64EncodedWireTransaction } from '@solana/kit'
import { walletClusterConfig } from './wallet-data-config.ts'
import type { WalletCluster } from './wallet-data-config.ts'

export type TransactionPreflight =
  | { status: 'valid' }
  | {
      status: 'blocked'
      reason: 'expired' | 'simulation_failed' | 'rpc_unavailable' | 'invalid_transaction'
      message: string
      details?: string
    }
  | { status: 'blocked'; reason: 'dangerous_effects'; message: string; disposition: Extract<SigningDisposition, { status: 'block' }> }

type Simulate = (bytes: Base64EncodedWireTransaction, cluster: WalletCluster) => Promise<{
  err: unknown
  innerInstructions?: unknown
  logs?: readonly string[] | null
}>

const simulate: Simulate = async (bytes, cluster) => {
  const rpc = createSolanaRpc(walletClusterConfig(cluster).rpcUrl)
  const result = await rpc.simulateTransaction(bytes, {
    encoding: 'base64', commitment: 'confirmed', replaceRecentBlockhash: false, sigVerify: false, innerInstructions: true,
  }).send()
  return result.value
}

/** Validate exact dapp bytes, including legacy/v0 and their original lifetime token. */
export async function preflightTransaction(
  transaction: Uint8Array,
  cluster: WalletCluster,
  runSimulation: Simulate = simulate,
): Promise<TransactionPreflight> {
  let bytes: Base64EncodedWireTransaction
  try {
    bytes = getBase64EncodedWireTransaction(getTransactionDecoder().decode(transaction))
  } catch {
    return { status: 'blocked', reason: 'invalid_transaction', message: 'The app supplied an invalid transaction. Cancel and start again from the app.' }
  }
  try {
    const result = await runSimulation(bytes, cluster)
    if (result.err === null) {
      const block = simulationSigningBlock(result.innerInstructions)
      return block ? { status: 'blocked', reason: 'dangerous_effects', message: signingPolicyMessage(block), disposition: block } : { status: 'valid' }
    }
    if (result.err === 'BlockhashNotFound') {
      return { status: 'blocked', reason: 'expired', message: 'This transaction’s blockhash is no longer valid. Cancel and start a new request from the app. Nothing was signed.' }
    }
    const details = JSON.stringify(result.err, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
    return {
      status: 'blocked', reason: 'simulation_failed',
      message: 'This transaction failed simulation and cannot be signed. Check the transaction details below before retrying.',
      details: [details, ...(result.logs ?? []).slice(-6).map((line) => line.slice(0, 500))].join('\n'),
    }
  } catch {
    return { status: 'blocked', reason: 'rpc_unavailable', message: 'The Solana RPC could not validate this transaction. Retry the check before signing.' }
  }
}
