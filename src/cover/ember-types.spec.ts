import { expect, test } from 'vitest'

import {
  coverCapExhausted,
  coverPeriodExpired,
  coverStatusActive,
  isCoverable,
  normalizeCoverCapContext,
  normalizeCoverStatusSnapshot,
} from './ember-types.ts'

test('covered decision is coverable', () => {
  expect(isCoverable({ coverStatus: 'covered' })).toBe(true)
})

test('unavailable decision is not coverable', () => {
  expect(isCoverable({ coverStatus: 'unavailable' })).toBe(false)
})

test('normalizes cap context from the backend pre-sign response', () => {
  expect(
    normalizeCoverCapContext({
      capContext: { monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 },
    }),
  ).toEqual({
    monthlyLossCapUsd: 10000,
    remainingCoveredTxThisMonth: 99,
  })
})

test('missing cap context normalizes to null', () => {
  expect(normalizeCoverCapContext({})).toBeNull()
})

test('normalizes a non-consuming cover status snapshot', () => {
  expect(
    normalizeCoverStatusSnapshot({
      subscriptionActive: true,
      subscriptionStatus: 'active',
      walletRegistered: true,
      tier: 'demo',
      month: '2026-06',
      currentPeriodEnd: '2026-07-01T00:00:00Z',
      coveredTxPerMonth: 100,
      usedCoveredTxThisMonth: 1,
      remainingCoveredTxThisMonth: 99,
      monthlyLossCapUsd: 10000,
      usedLossCapUsd: 0,
      remainingLossCapUsd: 10000,
    }),
  ).toEqual({
    subscriptionActive: true,
    subscriptionStatus: 'active',
    walletRegistered: true,
    tier: 'demo',
    month: '2026-06',
    currentPeriodEnd: '2026-07-01T00:00:00Z',
    coveredTxPerMonth: 100,
    usedCoveredTxThisMonth: 1,
    remainingCoveredTxThisMonth: 99,
    monthlyLossCapUsd: 10000,
    usedLossCapUsd: 0,
    remainingLossCapUsd: 10000,
  })
})

test('rejects malformed status snapshots', () => {
  expect(normalizeCoverStatusSnapshot({ coveredTxPerMonth: 100 })).toBeNull()
})

test('cover is active only when the API flag, status, registration, and period all agree', () => {
  const snapshot = normalizeCoverStatusSnapshot({
    subscriptionActive: true,
    subscriptionStatus: 'active',
    walletRegistered: true,
    tier: 'Core',
    month: '2026-07',
    currentPeriodEnd: '2026-08-24T00:00:00Z',
    coveredTxPerMonth: 100,
    usedCoveredTxThisMonth: 0,
    remainingCoveredTxThisMonth: 100,
    monthlyLossCapUsd: 10000,
    usedLossCapUsd: 0,
    remainingLossCapUsd: 10000,
  })

  expect(snapshot).not.toBeNull()
  expect(coverStatusActive(snapshot!, Date.parse('2026-07-25T00:00:00Z'))).toBe(true)
  expect(coverStatusActive(snapshot!, Date.parse('2026-08-25T00:00:00Z'))).toBe(false)
  expect(coverPeriodExpired(snapshot!, Date.parse('2026-08-25T00:00:00Z'))).toBe(true)
  expect(coverStatusActive({ ...snapshot!, walletRegistered: false })).toBe(false)
  expect(coverStatusActive({ ...snapshot!, subscriptionStatus: 'revoked' })).toBe(false)
})

test('exhausted cap is identified from the public decision reason', () => {
  expect(
    coverCapExhausted({
      coverStatus: 'not_covered',
      decisionReason: 'coverage_limit_reached',
    }),
  ).toBe(true)
  expect(
    coverCapExhausted({
      coverStatus: 'covered',
      decisionReason: 'coverage_limit_reached',
    }),
  ).toBe(false)
})
