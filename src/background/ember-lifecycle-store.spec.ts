import type {
  CoverageDecisionResponse,
  CoverageInstanceResponse,
  PaymentResponse,
} from '@embercover/wallet-sdk'
import { beforeEach, expect, test } from 'vitest'
import { fakeBrowser } from 'wxt/testing'

import { EmberLifecycleStore } from './ember-lifecycle-store.ts'

const PAYMENT = {
  paymentId: 'payment_test',
  quoteId: 'quote_test',
  paymentSignature: 'signature_test',
  status: 'pending',
  outcomeCode: 'awaiting_finality',
  providerAgreement: 'awaiting_finality',
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
  confidence: 'high',
  coverStatus: 'covered',
  coverageInstanceId: 'coverage_test',
  decisionExpiresAt: '2026-07-28T00:01:00.000Z',
  decisionId: 'decision_test',
  evaluationCountImpact: 1,
  evidenceState: 'pre_sign',
  exposureReservationMicros: '1000',
  exposureSnapshot: { scopes: [] },
  kind: 'transaction',
  maximumPayoutMicros: '1000',
  offerId: 'offer_test',
  offerVersion: 1,
  policyVersion: 'policy-v1',
  protectedWallet: '11111111111111111111111111111111',
  quoteId: 'quote_test',
  reasonCodes: ['simple_system_transfer'],
  remainingAggregateLimitMicros: '999000',
  remainingUnderwritingEvaluations: 9,
  riskBand: 'low',
  termsVersion: 'terms-v1',
} satisfies CoverageDecisionResponse

beforeEach(() => fakeBrowser.reset())

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
    getCoverageInstance: async () => COVERAGE,
    getDecision: async () => ({ ...DECISION, evidenceState: 'sealed' }),
    getDecisionLineage: async () => ({
      artifacts: [],
      coverageInstanceId: COVERAGE.coverageInstanceId,
      decisionId: DECISION.decisionId,
      events: [],
      evidenceState: 'sealed',
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
    getPayment: async () => {
      throw new Error('offline')
    },
  } as never)
  expect(snapshot.authority).toBe('cache')
  expect(snapshot.error).toBe('offline')
})
