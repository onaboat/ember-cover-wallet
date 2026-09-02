import type {
  CoverageDecisionResponse,
  CoverageInstanceResponse,
  PaymentResponse,
  WalletClaimResponse,
} from '@embercover/wallet-sdk'
import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test, vi } from 'vitest'

import type { EmberRuntimeConfig } from '../cover/ember-config.ts'

import type { EmberClientCoordinator } from './ember-client-coordinator.ts'
import { EmberCoverProvider } from './cover-service.ts'
import { emberLifecycleStore } from './ember-lifecycle-store.ts'

const WALLET = 'So11111111111111111111111111111111111111112'
const CONFIG: EmberRuntimeConfig = {
  apiBaseUrl: 'http://127.0.0.1:18787',
  environment: 'sandbox',
  expectedCluster: 'devnet',
  expectedGenesisHash: null,
  extensionId: null,
  integrationId: 'integration_reference-wallet',
  problems: [],
}
const PAYMENT = {
  paymentId: 'payment_test',
  quoteId: 'quote_test',
  paymentSignature: 'signature_test',
  status: 'activated',
  coverageInstanceId: 'coverage_test',
  submittedAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
} satisfies PaymentResponse
const COVERAGE = {
  activatedAt: '2026-07-28T00:00:00.000Z',
  aggregateLimitMicros: '120000000000',
  appealWindowDays: 30,
  benefitPeriodCount: 12,
  benefitPeriodLimitMicros: '10000000000',
  coverageEndsAt: '2027-07-28T00:00:00.000Z',
  coverageInstanceId: 'coverage_test',
  coverageStartsAt: '2026-07-28T00:00:00.000Z',
  coveredTransactionLimit: 100,
  deductibleMicros: '0',
  delegateLossTailDays: 7,
  immediateLossClaimWindowDays: 7,
  offerId: 'offer_core',
  offerVersion: 1,
  paymentId: 'payment_test',
  paymentSignature: 'signature_test',
  perLossLimitMicros: '1000000000',
  policyVersion: 'policy-v1',
  protectedWallet: WALLET,
  quoteId: 'quote_test',
  currentBenefitPeriodEndsAt: '2026-08-28T00:00:00.000Z',
  currentBenefitPeriodOrdinal: 1,
  currentBenefitPeriodStartsAt: '2026-07-28T00:00:00.000Z',
  remainingBenefitPeriodLimitMicros: '10000000000',
  status: 'active',
  termsVersion: 'terms-v1',
  waitingPeriodDays: 0,
  walletSubjectId: 'wallet_subject_test',
} satisfies CoverageInstanceResponse
const DECISION = {
  coverStatus: 'covered',
  coverageInstanceId: COVERAGE.coverageInstanceId,
  decisionExpiresAt: '2027-07-28T00:01:00.000Z',
  decisionId: 'decision_test',
  decisionReason: 'eligible',
  evaluationCountImpact: 1,
  evidenceState: 'pre_sign',
  kind: 'transaction',
  maximumPayoutMicros: '1000',
  offerId: COVERAGE.offerId,
  offerVersion: 1,
  policyVersion: COVERAGE.policyVersion,
  protectedWallet: WALLET,
  quoteId: COVERAGE.quoteId,
  remainingAggregateLimitMicros: '9999000000',
  remainingUnderwritingEvaluations: 99,
  riskBand: 'low',
  termsVersion: COVERAGE.termsVersion,
} satisfies CoverageDecisionResponse

const signer = {
  getAddress: async () => WALLET,
  sign: async () => new Uint8Array(64).fill(1),
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getPayment: vi.fn(async () => PAYMENT),
    getCoverageInstance: vi.fn(async () => COVERAGE),
    getDecision: vi.fn(async () => DECISION),
    getDecisionLineage: vi.fn(async () => ({
      coverageInstanceId: COVERAGE.coverageInstanceId,
      decisionId: DECISION.decisionId,
      evidenceState: 'pre_sign',
      lifecycle: [],
      paymentId: PAYMENT.paymentId,
      quoteId: PAYMENT.quoteId,
    })),
    listClaims: vi.fn(async () => ({ claims: [] })),
    reviewForSigning: vi.fn(async () => ({ status: 'reviewed', decision: DECISION })),
    submitDecisionEvidence: vi.fn(async () => ({
      accepted: true,
      decisionId: DECISION.decisionId,
      evidenceState: 'post_sign',
    })),
    ...overrides,
  }
}

function fakeCoordinator(
  client: ReturnType<typeof fakeClient> | null,
  overrides: Record<string, unknown> = {},
): EmberClientCoordinator {
  return {
    activeClient: vi.fn(async () => client),
    enroll: vi.fn(async () => ({ sessionId: 'session_test' })),
    revoke: vi.fn(async () => {}),
    status: vi.fn(async () => ({
      environment: 'sandbox',
      expiresAt: '2027-07-28T00:00:00.000Z',
      phase: client ? 'active' : 'disconnected',
      refreshExpiresAt: '2027-07-29T00:00:00.000Z',
      walletAddress: WALLET,
      walletSubjectId: client ? 'wallet_subject_test' : null,
      problems: [],
    })),
    ...overrides,
  } as unknown as EmberClientCoordinator
}

async function providerWithCoverage(client = fakeClient()) {
  await emberLifecycleStore.recordPayment(WALLET, PAYMENT, COVERAGE)
  return {
    client,
    provider: new EmberCoverProvider(signer, {
      config: CONFIG,
      coordinator: fakeCoordinator(client),
    }),
  }
}

beforeEach(() => {
  fakeBrowser.reset()
  vi.restoreAllMocks()
})

test('reviews the exact transaction through the packaged SDK and maps its decision for the UI', async () => {
  const { client, provider } = await providerWithCoverage()
  const decision = await provider.preSign({
    cluster: 'devnet',
    dappUrl: 'https://dapp.example',
    transactionBytes: 'AQID',
  })
  expect(client.reviewForSigning).toHaveBeenCalledWith({
    coverageInstanceId: COVERAGE.coverageInstanceId,
    dappUrl: 'https://dapp.example',
    kind: 'transaction',
    transactionBytes: 'AQID',
  })
  expect(decision).toMatchObject({
    coverStatus: 'covered',
    requestId: DECISION.decisionId,
    coveredTxCountImpact: 1,
  })
})

test('reviews messages with the SDK message contract', async () => {
  const client = fakeClient({
    reviewForSigning: vi.fn(async () => ({
      status: 'reviewed',
      decision: { ...DECISION, kind: 'message' },
    })),
  })
  const { provider } = await providerWithCoverage(client)
  await provider.preSignMessage({
    dappUrl: 'https://dapp.example',
    messageBytes: 'AQID',
    messageKind: 'wallet_standard_sign_message',
    walletMethod: 'signMessage',
  })
  expect(client.reviewForSigning).toHaveBeenCalledWith({
    coverageInstanceId: COVERAGE.coverageInstanceId,
    dappUrl: 'https://dapp.example',
    kind: 'message',
    messageBytes: 'AQID',
    walletMethod: 'signMessage',
  })
})

test('does not call Ember when no live scoped session exists', async () => {
  const provider = new EmberCoverProvider(signer, {
    config: CONFIG,
    coordinator: fakeCoordinator(null),
  })
  expect((await provider.preSign({ transactionBytes: 'AQID' })).coverStatus).toBe('not_covered')
})

test('rejects a transaction from a cluster other than the build binding before API use', async () => {
  const { client, provider } = await providerWithCoverage()
  const decision = await provider.preSign({
    cluster: 'mainnet-beta',
    transactionBytes: 'AQID',
  })
  expect(decision.coverStatus).toBe('unavailable')
  expect(decision.decisionReason).toBe('temporarily_unavailable')
  expect(decision.debug?.stage).toBe('cluster_mismatch')
  expect(client.reviewForSigning).not.toHaveBeenCalled()
})

test('server lifecycle records, not local assumptions, produce the status snapshot', async () => {
  const { provider } = await providerWithCoverage()
  const status = await provider.status()
  expect(status).toMatchObject({
    subscriptionActive: true,
    tier: COVERAGE.offerId,
    coveredTxPerMonth: 100,
    remainingCoveredTxThisMonth: 100,
  })
})

test('enrollment and revocation delegate to the session coordinator', async () => {
  const coordinator = fakeCoordinator(fakeClient())
  const provider = new EmberCoverProvider(signer, { config: CONFIG, coordinator })
  expect(await provider.enroll()).toBe(true)
  await provider.revoke()
  expect(coordinator.enroll).toHaveBeenCalledOnce()
  expect(coordinator.revoke).toHaveBeenCalledOnce()
})

test('enrollment preserves the SDK failure so the wallet can explain it', async () => {
  const coordinator = fakeCoordinator(null, {
    enroll: vi.fn(async () => {
      throw new Error('exact challenge failure')
    }),
  })
  const provider = new EmberCoverProvider(signer, { config: CONFIG, coordinator })

  await expect(provider.enroll()).rejects.toThrow('exact challenge failure')
})

test('post-sign stores exact evidence durably even when no live client can drain it', async () => {
  const provider = new EmberCoverProvider(signer, {
    config: CONFIG,
    coordinator: fakeCoordinator(null),
  })
  await provider.postSign({
    requestId: DECISION.decisionId,
    signedBytes: 'signed-transaction',
    signingWalletPublicKey: WALLET,
    walletTimestamp: '2026-07-28T00:00:00.000Z',
  })
  expect(await storage.getItem('local:ember-evidence-outbox:v1')).toMatchObject([
    {
      decisionId: DECISION.decisionId,
      request: {
        kind: 'transaction',
        signedBytes: 'signed-transaction',
      },
    },
  ])
})

test('SDK unavailable reviews remain explicitly unavailable', async () => {
  const client = fakeClient({
    reviewForSigning: vi.fn(async () => ({
      status: 'unavailable',
      coverStatus: 'unavailable',
      reason: 'network',
    })),
  })
  const { provider } = await providerWithCoverage(client)
  expect((await provider.preSign({ transactionBytes: 'AQID' }))).toMatchObject({
    coverStatus: 'unavailable',
    decisionReason: 'temporarily_unavailable',
    debug: { error: 'network' },
  })
})

test('claim eligibility and intake use the SDK decision identifier without payout actions', async () => {
  const claim: WalletClaimResponse = {
    claimId: 'claim_test',
    claimedAmountMicros: '1000000',
    coverageInstanceId: COVERAGE.coverageInstanceId,
    decisionId: DECISION.decisionId,
    evidenceRequests: [],
    lossEvent: 'direct_malicious_signing_loss',
    protectedWallet: WALLET,
    reviewDueAt: '2026-08-01T00:00:00.000Z',
    state: 'submitted',
    submittedAt: '2026-07-28T00:00:00.000Z',
    timeline: [],
    version: 1,
  }
  const createClaim = vi.fn(async () => claim)
  const client = fakeClient({
    claimEligibility: vi.fn(async () => ({
      decisionId: DECISION.decisionId,
      eligible: true,
    })),
    createClaim,
  })
  const provider = new EmberCoverProvider(signer, {
    config: CONFIG,
    coordinator: fakeCoordinator(client),
  })

  expect(await provider.claimEligibility(DECISION.decisionId)).toEqual({
    decisionId: DECISION.decisionId,
    eligible: true,
  })
  expect(
    await provider.createClaim({
      claimedAmountMicros: '1000000',
      decisionId: DECISION.decisionId,
      lossEvent: 'direct_malicious_signing_loss',
      statement: 'A malicious transaction caused a direct loss.',
    }),
  ).toEqual(claim)
  expect(createClaim).toHaveBeenCalledOnce()
  expect(Object.keys(client)).not.toContain('createPayout')
})
