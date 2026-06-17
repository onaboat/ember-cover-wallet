import { expect, test } from 'vitest'

import { isExpired } from './cover-decision-logic.ts'

test('decision is expired once now passes its expiry', () => {
  expect(isExpired({ decisionExpiresAt: '2026-06-16T00:00:00Z' }, Date.parse('2026-06-16T00:00:01Z'))).toBe(true)
})

test('decision is not expired before its expiry', () => {
  expect(isExpired({ decisionExpiresAt: '2026-06-16T00:01:00Z' }, Date.parse('2026-06-16T00:00:00Z'))).toBe(false)
})
