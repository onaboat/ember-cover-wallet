import { expect, test } from 'vitest'

import { formatUsdcBaseUnits, prepaidPaymentConfig } from './prepaid-payment-config.ts'

test('matches the deployed Devnet prepaid contract', () => {
  expect(prepaidPaymentConfig()).toMatchObject({
    cluster: 'devnet',
    amountBaseUnits: 1_000_000n,
    amountUsdc: '1',
    decimals: 6,
    periodDays: 30,
    tier: 'Core',
    tokenMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    treasuryTokenAccount: 'AmXrozEs535RMiwSxkjhcyuq5reC9ntvtBXCef8wCP6s',
  })
})

test('formats six-decimal USDC base units', () => {
  expect(formatUsdcBaseUnits(1_000_000n)).toBe('1')
  expect(formatUsdcBaseUnits(1_250_000n)).toBe('1.25')
  expect(formatUsdcBaseUnits(1n)).toBe('0.000001')
})
