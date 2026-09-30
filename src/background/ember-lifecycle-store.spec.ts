import {
  EmberApiError,
  type CoverageDecisionResponse,
  type CoverageInstanceResponse,
  type PaymentResponse,
} from '@embercover/wallet-sdk'
import { beforeEach, expect, test, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'

import { EmberLifecycleStore } from './ember-lifecycle-store.ts'

const PAYMENT = {
  paymentId: 'payment_test',
  quoteId: 'quote_test',
  paymentSignature: 'signature_test',
  status: 'pending',
  submittedAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
} satisfies PaymentResponse

const COVERAGE = {
  activatedAt: '2026-07-28T00:00:00.000Z',
  aggregateLimitMicros: '1000000',
  appealWindowDays: 30,
  benefitPeriodCount: 1,
  benefitPeriodLimitMicros: '1000000',
  coverageEndsAt: '2027-07-28T00:00:00.000Z',
  coverageInstanceId: 'coverage_test',
  coverageStartsAt: '2026-07-28T00:00:00.000Z',
  coveredTransactionLimit: 10,
  deductibleMicros: '0',
  delegateLossTailDays: 7,
  immediateLossClaimWindowDays: 7,
  offerId: 'offer_test',
  offerVersion: 1,
  paymentId: 'payment_test',
  paymentSignature: 'signature_test',
  perLossLimitMicros: '1000000',
  policyVersion: 'policy-v1',
  protectedWallet: '11111111111111111111111111111111',
  quoteId: 'quote_test',
  status: 'active',
  termsVersion: 'terms-v1',
  waitingPeriodDays: 0,
  walletSubjectId: 'wallet_subject_test',
} satisfies CoverageInstanceResponse

const DECISION = {
  coverStatus: 'covered',
  coverageInstanceId: 'coverage_test',
  decisionExpiresAt: '2026-07-28T00:01:00.000Z',
  decisionId: 'decision_test',
  decisionReason: 'eligible',
  evaluationCountImpact: 0,
    allowance: { limit: 100, committed: 0, reserved: 1, available: 99 },
  evidenceState: 'pre_sign',
  kind: 'transaction',
  maximumPayoutMicros: '1000',
  offerId: 'offer_test',
  offerVersion: 1,
  policyVersion: 'policy-v1',
  protectedWallet: '11111111111111111111111111111111',
  quoteId: 'quote_test',
  remainingAggregateLimitMicros: '999000',
  remainingUnderwritingEvaluations: 9,
  riskBand: 'low',
  termsVersion: 'terms-v1',
} satisfies CoverageDecisionResponse

beforeEach(() => fakeBrowser.reset())

test('scrubs the legacy provider-shaped lifecycle cache on first load', async () => {
  await storage.setItem('local:ember-authoritative-lifecycle-cache:v1', {
    version: 1,
    walletAddress: COVERAGE.protectedWallet,
    decisions: [{ cachedDecision: { reasonCodes: ['internal_policy_detail'] } }],
  })
  const store = new EmberLifecycleStore()

  expect(await store.load(COVERAGE.protectedWallet)).toMatchObject({
    version: 2,
    decisions: [],
    claims: [],
  })
  expect(
    await storage.getItem('local:ember-authoritative-lifecycle-cache:v1'),
  ).toBeNull()
})

test('local state stores identifiers and cached display data but refresh uses server authority', async () => {
  const store = new EmberLifecycleStore(() => new Date('2026-07-28T00:00:00.000Z'))
  await store.recordPayment(COVERAGE.protectedWallet, PAYMENT, COVERAGE)
  await store.recordDecision({
    walletAddress: COVERAGE.protectedWallet,
    decision: DECISION,
    signature: 'signature_test',
  })
  const client = {
    getPayment: async () => ({ ...PAYMENT, status: 'activated', coverageInstanceId: COVERAGE.coverageInstanceId }),
    getCurrentCoverage: vi.fn(async () => ({ status: 'active', coverage: COVERAGE, allowance: { limit: 100, committed: 0, reserved: 1, available: 99 } })),
    getCoverageInstance: async () => COVERAGE,
    getDecision: async () => ({ ...DECISION, evidenceState: 'sealed' }),
    getDecisionLineage: async () => ({
      coverageInstanceId: COVERAGE.coverageInstanceId,
      decisionId: DECISION.decisionId,
      evidenceState: 'sealed',
      lifecycle: [],
      paymentId: PAYMENT.paymentId,
      quoteId: PAYMENT.quoteId,
    }),
    listClaims: async () => ({ claims: [] }),
  }
  const snapshot = await store.refresh(
    COVERAGE.protectedWallet,
    client as never,
  )
  expect(snapshot.authority).toBe('server')
  expect(snapshot.payment?.status).toBe('activated')
  expect(snapshot.decisions[0]?.cachedDecision.evidenceState).toBe('sealed')
})

test('API failure marks cached records as non-authoritative', async () => {
  const store = new EmberLifecycleStore()
  await store.recordPayment(COVERAGE.protectedWallet, PAYMENT, null)
  const snapshot = await store.refresh(COVERAGE.protectedWallet, {
    getCurrentCoverage: async () => {
      throw new Error('offline')
    },
  } as never)
  expect(snapshot.authority).toBe('cache')
  expect(snapshot.error).toBe('offline')
})

test('decision coverage lookup never synchronizes decisions, lineage, or claims', async () => {
  const now = new Date('2026-07-28T00:00:00.000Z')
  const store = new EmberLifecycleStore(() => now)
  await store.recordPayment(COVERAGE.protectedWallet, PAYMENT, COVERAGE)
  await store.recordDecision({
    walletAddress: COVERAGE.protectedWallet,
    decision: DECISION,
  })
  const client = {
    getPayment: vi.fn(async () => PAYMENT),
    getCurrentCoverage: vi.fn(async () => ({ status: 'active', coverage: COVERAGE, allowance: { limit: 100, committed: 0, reserved: 1, available: 99 } })),
    getCoverageInstance: vi.fn(async () => COVERAGE),
    getDecision: vi.fn(async () => DECISION),
    getDecisionLineage: vi.fn(async () => ({ lifecycle: [] })),
    listClaims: vi.fn(async () => ({ claims: [] })),
  }

  const snapshot = await store.resolveCoverageForDecision(
    COVERAGE.protectedWallet,
    client as never,
  )

  expect(snapshot.authority).toBe('server')
  expect(snapshot.coverage?.coverageInstanceId).toBe(COVERAGE.coverageInstanceId)
  expect(client.getPayment).not.toHaveBeenCalled()
  expect(client.getCoverageInstance).not.toHaveBeenCalled()
  expect(client.getDecision).not.toHaveBeenCalled()
  expect(client.getDecisionLineage).not.toHaveBeenCalled()
  expect(client.listClaims).not.toHaveBeenCalled()
})

test('missing coverage uses one targeted refresh without lifecycle fan-out', async () => {
  const store = new EmberLifecycleStore(() => new Date('2026-07-28T00:00:00.000Z'))
  await store.recordPayment(COVERAGE.protectedWallet, PAYMENT, null)
  const client = {
    getPayment: vi.fn(async () => ({
      ...PAYMENT,
      coverageInstanceId: COVERAGE.coverageInstanceId,
    })),
    getCurrentCoverage: vi.fn(async () => ({ status: 'active', coverage: COVERAGE, allowance: { limit: 100, committed: 0, reserved: 1, available: 99 } })),
    getCoverageInstance: vi.fn(async () => COVERAGE),
    getDecision: vi.fn(async () => DECISION),
    getDecisionLineage: vi.fn(async () => ({ lifecycle: [] })),
    listClaims: vi.fn(async () => ({ claims: [] })),
  }

  const snapshot = await store.resolveCoverageForDecision(
    COVERAGE.protectedWallet,
    client as never,
  )

  expect(snapshot.authority).toBe('server')
  expect(client.getPayment).not.toHaveBeenCalled()
  expect(client.getCurrentCoverage).toHaveBeenCalledOnce()
  expect(client.getDecision).not.toHaveBeenCalled()
  expect(client.getDecisionLineage).not.toHaveBeenCalled()
  expect(client.listClaims).not.toHaveBeenCalled()
})

test('discovers paid coverage without any saved payment or coverage references', async () => {
  const store = new EmberLifecycleStore()
  const getCurrentCoverage = vi.fn(async () => ({ status: 'active', coverage: COVERAGE, allowance: { limit: 100, committed: 3, reserved: 2, available: 95 } }))
  const snapshot = await store.refreshCoverage(COVERAGE.protectedWallet, { getCurrentCoverage } as never)
  expect(getCurrentCoverage).toHaveBeenCalledOnce()
  expect(snapshot.coverage?.coverageInstanceId).toBe(COVERAGE.coverageInstanceId)
  expect(snapshot.allowance?.available).toBe(95)
})

test('old payment failure does not prevent discovery of current active coverage', async () => {
  const store = new EmberLifecycleStore(() => new Date('2026-09-22T00:00:00Z'))
  await store.recordPayment(COVERAGE.protectedWallet, PAYMENT, COVERAGE)
  const getCurrentCoverage = vi.fn(async () => ({ status: 'active', coverage: { ...COVERAGE, coverageInstanceId: 'fresh-coverage' }, allowance: { limit: 10, committed: 0, reserved: 0, available: 10 } }))
  const client = { getPayment: async () => { throw new Error('payment not found') }, getCurrentCoverage } as never
  const refreshed = await store.refresh(COVERAGE.protectedWallet, client)
  expect(refreshed.authority).toBe('server')
  expect(refreshed.historyError).toContain('history')
  expect(getCurrentCoverage).toHaveBeenCalled()
  const resolved = await store.resolveCoverageForDecision(COVERAGE.protectedWallet, client)
  expect(resolved.coverage?.coverageInstanceId).toBe('fresh-coverage')
  expect(getCurrentCoverage).toHaveBeenCalled()
})

test('missing decision history preserves fresh coverage and identifies cached history', async () => {
  const store = new EmberLifecycleStore()
  await store.recordPayment(COVERAGE.protectedWallet, PAYMENT, COVERAGE)
  await store.recordDecision({ walletAddress: COVERAGE.protectedWallet, decision: DECISION })
  const fresh = { ...COVERAGE, coverageInstanceId: 'new-authority' }
  const snapshot = await store.refresh(COVERAGE.protectedWallet, {
    getPayment: async () => PAYMENT,
    getCurrentCoverage: async () => ({ status: 'active', coverage: fresh, allowance: { limit: 10, committed: 0, reserved: 0, available: 10 } }),
    getDecision: async () => { throw new Error('not found') },
    getDecisionLineage: async () => { throw new Error('not found') },
    listClaims: async () => ({ claims: [] }),
  } as never)
  expect(snapshot.authority).toBe('server')
  expect(snapshot.coverage?.coverageInstanceId).toBe('new-authority')
  expect(snapshot.allowance?.available).toBe(10)
  expect(snapshot.historyError).toContain('history')
  expect(snapshot.decisions[0]?.decisionId).toBe(DECISION.decisionId)
})


function historyClient(getDecision: () => Promise<CoverageDecisionResponse>) {
  return {
    getPayment: async () => PAYMENT,
    getCurrentCoverage: async () => ({ status: 'active', coverage: COVERAGE, allowance: { limit: 100, committed: 0, reserved: 0, available: 100 } }),
    getDecision: vi.fn(getDecision),
    getDecisionLineage: vi.fn(async () => ({ lifecycle: [] })),
    listClaims: async () => ({ claims: [] }),
  }
}

test('does not refetch a decision once its evidence is settled', async () => {
  const store = new EmberLifecycleStore()
  await store.recordDecision({ walletAddress: COVERAGE.protectedWallet, decision: DECISION })
  const client = historyClient(async () => ({ ...DECISION, evidenceState: 'sealed' }))
  await store.refresh(COVERAGE.protectedWallet, client as never)
  await store.refresh(COVERAGE.protectedWallet, client as never)
  expect(client.getDecision).toHaveBeenCalledOnce()
})

test('keeps refreshing a decision that is still awaiting evidence', async () => {
  const store = new EmberLifecycleStore()
  await store.recordDecision({ walletAddress: COVERAGE.protectedWallet, decision: DECISION })
  const client = historyClient(async () => DECISION)
  await store.refresh(COVERAGE.protectedWallet, client as never)
  await store.refresh(COVERAGE.protectedWallet, client as never)
  expect(client.getDecision).toHaveBeenCalledTimes(2)
})

test('forgets a decision the server reports as not found', async () => {
  const store = new EmberLifecycleStore()
  await store.recordDecision({ walletAddress: COVERAGE.protectedWallet, decision: DECISION })
  const client = historyClient(async () => { throw new EmberApiError(404, undefined, undefined) })
  const snapshot = await store.refresh(COVERAGE.protectedWallet, client as never)
  expect(snapshot.decisions).toEqual([])
})

test('fresh backend absence stays authoritative when old payment history no longer exists', async () => {
  const store = new EmberLifecycleStore()
  await store.recordPayment(COVERAGE.protectedWallet, PAYMENT, COVERAGE)
  const client = {
    getCurrentCoverage: async () => ({ status: 'none' as const }),
    getPayment: async () => { throw new Error('payment not found') },
    listClaims: async () => ({ claims: [] }),
  }
  const snapshot = await store.refresh(COVERAGE.protectedWallet, client as never)
  expect(snapshot).toMatchObject({ authority: 'server', coverage: null, allowance: null, error: null })
  expect(snapshot.payment).toEqual(PAYMENT)
  expect(snapshot.historyError).toContain('history')
})
