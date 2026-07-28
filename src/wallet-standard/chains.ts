import {
  SOLANA_DEVNET_CHAIN,
  SOLANA_MAINNET_CHAIN,
} from '@solana/wallet-standard-chains'
import type { IdentifierArray, IdentifierString } from '@wallet-standard/core'

import { EMBER_CONFIG } from '../cover/ember-config.ts'
import type { WalletCluster } from '../background/wallet-data-config.ts'

const configuredChain =
  EMBER_CONFIG.expectedCluster === 'mainnet-beta'
    ? SOLANA_MAINNET_CHAIN
    : SOLANA_DEVNET_CHAIN

export const EMBER_SOLANA_CHAINS: IdentifierArray = [configuredChain]

export function walletClusterForChain(chain: IdentifierString | undefined): WalletCluster {
  if (chain === undefined) {
    throw new Error('A Solana chain identifier is required for transaction signing.')
  }
  const cluster =
    chain === SOLANA_DEVNET_CHAIN
      ? 'devnet'
      : chain === SOLANA_MAINNET_CHAIN
        ? 'mainnet-beta'
        : null
  if (!cluster) {
    throw new Error(`Ember does not support transaction signing on ${chain}.`)
  }
  if (cluster !== EMBER_CONFIG.expectedCluster) {
    throw new Error(
      `This Ember build is bound to ${EMBER_CONFIG.expectedCluster}, not ${cluster}.`,
    )
  }
  return cluster
}
