import { expect, test } from 'vitest'

import {
  DEVNET_USDC_MINT,
  shortTokenMint,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  trustedTokenMetadata,
} from './token-metadata.ts'

test('trusts only the curated Devnet USDC identity', () => {
  expect(trustedTokenMetadata('devnet', DEVNET_USDC_MINT, TOKEN_PROGRAM_ADDRESS)).toMatchObject({
    name: 'USD Coin',
    symbol: 'USDC',
    iconText: '$',
  })
  expect(trustedTokenMetadata('mainnet-beta', DEVNET_USDC_MINT, TOKEN_PROGRAM_ADDRESS)).toBeNull()
  expect(trustedTokenMetadata('devnet', DEVNET_USDC_MINT, TOKEN_2022_PROGRAM_ADDRESS)).toBeNull()
})

test('shortens unknown mint addresses without changing short values', () => {
  expect(shortTokenMint('Mint111111111111111111111111111111111111111')).toBe('Mint…1111')
  expect(shortTokenMint('short')).toBe('short')
})
