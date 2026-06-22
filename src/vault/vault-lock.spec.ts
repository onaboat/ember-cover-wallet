import { expect, test } from 'vitest'

import { isVaultLockedError } from './vault-lock.ts'

test('classifies a re-locked vault sign error so the UI can re-prompt for unlock', () => {
  expect(isVaultLockedError('vault is locked')).toBe(true)
})

test('classifies the lockout variant as a vault-lock error', () => {
  expect(isVaultLockedError('vault is locked out')).toBe(true)
})

test('does not classify unrelated errors as vault-lock', () => {
  expect(isVaultLockedError('Network request failed')).toBe(false)
})
