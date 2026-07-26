import {
  SOLANA_DEVNET_CHAIN,
  SOLANA_LOCALNET_CHAIN,
  SOLANA_MAINNET_CHAIN,
} from '@solana/wallet-standard-chains'
import { expect, test } from 'vitest'

import { EMBER_SOLANA_CHAINS, walletClusterForChain } from './chains.ts'

test('advertises only the configured Devnet and Mainnet clusters', () => {
  expect(EMBER_SOLANA_CHAINS).toEqual([SOLANA_DEVNET_CHAIN, SOLANA_MAINNET_CHAIN])
})

test('defaults chainless requests to Devnet and rejects unsupported clusters', () => {
  expect(walletClusterForChain(undefined)).toBe('devnet')
  expect(walletClusterForChain(SOLANA_DEVNET_CHAIN)).toBe('devnet')
  expect(walletClusterForChain(SOLANA_MAINNET_CHAIN)).toBe('mainnet-beta')
  expect(() => walletClusterForChain(SOLANA_LOCALNET_CHAIN)).toThrow('does not support')
})
