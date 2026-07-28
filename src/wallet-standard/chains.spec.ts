import {
  SOLANA_DEVNET_CHAIN,
  SOLANA_LOCALNET_CHAIN,
  SOLANA_MAINNET_CHAIN,
} from '@solana/wallet-standard-chains'
import { expect, test } from 'vitest'

import { EMBER_SOLANA_CHAINS, walletClusterForChain } from './chains.ts'

test('advertises only the cluster bound to this build', () => {
  expect(EMBER_SOLANA_CHAINS).toEqual([SOLANA_DEVNET_CHAIN])
})

test('rejects chainless, unsupported, and non-bound cluster requests', () => {
  expect(() => walletClusterForChain(undefined)).toThrow('required')
  expect(walletClusterForChain(SOLANA_DEVNET_CHAIN)).toBe('devnet')
  expect(() => walletClusterForChain(SOLANA_MAINNET_CHAIN)).toThrow('bound to')
  expect(() => walletClusterForChain(SOLANA_LOCALNET_CHAIN)).toThrow('does not support')
})
