import { expect, test } from 'vitest'
import { simulatedWalletImpact } from './simulation-effects.ts'

test('preserves one-lamport precision above the JavaScript safe integer limit', () => {
  const impact = simulatedWalletImpact({ contextSlot: '100', solBalanceBefore: '9007199254740993', solBalanceAfter: '9007199254740992', tokenBalances: [] })
  expect(impact?.rows[0]?.value).toBe('-0.000000001 SOL')
  expect(impact?.isComplete).toBe(false)
})

test('shows sponsored token effects without inventing a native balance observation', () => {
  const impact = simulatedWalletImpact({ contextSlot: '100', tokenBalances: [{ account: 'token account', mint: 'mint', preAmount: '10', postAmount: '0' }] })
  expect(impact?.rows[0]?.value).toBe('-10 raw token units')
  expect(impact?.rows.some(row => row.label.includes('SOL'))).toBe(false)
})

test('does not display malformed observed amounts', () => {
  expect(simulatedWalletImpact({ contextSlot: '100', solBalanceBefore: '1e9', solBalanceAfter: '0', tokenBalances: [] })).toBeNull()
})
