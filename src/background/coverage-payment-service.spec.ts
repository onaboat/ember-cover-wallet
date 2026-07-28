import type {
  AvailableOfferResponse,
  CoverageInstanceResponse,
  PaymentResponse,
  SignedQuoteResponse,
} from '@embercover/wallet-sdk'
import {
  AccountRole,
  address as toAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from '@solana/kit'
import type { Signature } from '@solana/kit'
import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test, vi } from 'vitest'

import {
  MAINNET_GENESIS_HASH,
} from '../cover/ember-config.ts'
import type { EmberRuntimeConfig } from '../cover/ember-config.ts'

import type { EmberLifecycleProvider } from './cover-service.ts'
import {
  bindQuoteReference,
  CoveragePaymentProvider,
} from './coverage-payment-service.ts'
import type { CoveragePaymentRpc } from './coverage-payment-service.ts'

const WALLET = 'So11111111111111111111111111111111111111112'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TREASURY = 'AmXrozEs535RMiwSxkjhcyuq5reC9ntvtBXCef8wCP6s'
const TREASURY_OWNER = 'Vote111111111111111111111111111111111111111'
const REFERENCE = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const NOW = Date.parse('2026-07-28T00:00:00.000Z')
const CONFIG: EmberRuntimeConfig = {
  apiBaseUrl: 'https://api.ember.example',
  environment: 'production',
  expectedCluster: 'mainnet-beta',
  expectedGenesisHash: MAINNET_GENESIS_HASH,
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  integrationId: 'integration_reference-wallet',
  problems: [],
}
const OFFER = {
  aggregateLimitMicros: '10000000000',
  appealWindowDays: 30,
  availabilityMode: 'live',
  cancellationRuleCode: 'non_refundable',
  catalogueSha256: 'a'.repeat(64),
  cluster: 'mainnet-beta',
  coverageDurationDays: 30,
  coveredTransactionLimit: 100,
  deductibleMicros: '0',
  delegateLossTailDays: 7,
  displayName: 'Core',
  environment: 'production',
  immediateLossClaimWindowDays: 7,
  lifecycle: 'active',
  offerId: 'offer_core',
  offerVersion: 3,
  payerMustEqualProtectedWallet: true,
  paymentAsset: 'USDC',
  paymentAssetDecimals: 6,
  paymentMint: MINT,
  paymentTokenProgram: TOKEN_PROGRAM,
  perLossLimitMicros: '1000000000',
  policySha256: 'b'.repeat(64),
  policyVersion: 'policy-v3',
  priceBaseUnits: '1000000',
  productCode: 'core',
  protectedWalletCount: 1,
  refundRuleCode: 'none',
  snapshotSha256: 'c'.repeat(64),
  termsSha256: 'd'.repeat(64),
  termsVersion: 'terms-v3',
  waitingPeriodDays: 0,
} satisfies AvailableOfferResponse
const QUOTE = {
  payload: {
    createsCoverage: true,
    integrationId: CONFIG.integrationId!,
    integrationVersion: 1,
    mode: 'live',
    nonce: 'nonce_test',
    offer: {
      aggregateLimit: OFFER.aggregateLimitMicros,
      appealWindowDays: OFFER.appealWindowDays,
      availabilityId: 'availability_test',
      cancellationRuleCode: OFFER.cancellationRuleCode,
      catalogueHash: OFFER.catalogueSha256,
      cluster: 'mainnet-beta',
      commission: { kind: 'manual' },
      coverageDurationDays: OFFER.coverageDurationDays,
      coveredTransactionLimit: OFFER.coveredTransactionLimit,
      deductible: OFFER.deductibleMicros,
      delegateLossTailDays: OFFER.delegateLossTailDays,
      environment: 'production',
      immediateLossClaimWindowDays: OFFER.immediateLossClaimWindowDays,
      offerId: OFFER.offerId,
      offerVersion: OFFER.offerVersion,
      payerMustEqualProtectedWallet: true,
      paymentAsset: 'USDC',
      paymentAssetDecimals: 6,
      perLossLimit: OFFER.perLossLimitMicros,
      policyHash: OFFER.policySha256,
      policyVersion: OFFER.policyVersion,
      price: OFFER.priceBaseUnits,
      productCode: OFFER.productCode,
      protectedWalletCount: 1,
      refundRuleCode: OFFER.refundRuleCode,
      resolvedAt: '2026-07-28T00:00:00.000Z',
      snapshotSchemaVersion: 1,
      snapshotSha256: OFFER.snapshotSha256,
      termsHash: OFFER.termsSha256,
      termsVersion: OFFER.termsVersion,
      waitingPeriodDays: 0,
    },
    partnerId: 'partner_test',
    payerWallet: WALLET,
    payment: {
      amount: OFFER.priceBaseUnits,
      decimals: 6,
      genesisHash: MAINNET_GENESIS_HASH,
      mint: MINT,
      reference: REFERENCE,
      tokenProgram: TOKEN_PROGRAM,
      treasuryOwner: TREASURY_OWNER,
      treasuryTokenAccount: TREASURY,
    },
    paymentAllowed: true,
    protectedWallet: WALLET,
    quoteId: 'quote_live_test',
    schemaVersion: 2,
    signingKeyId: 'quote_key_test',
    termsAcceptanceId: 'acceptance_test',
    validity: {
      expiresAt: '2026-07-28T00:10:00.000Z',
      issuedAt: '2026-07-28T00:00:00.000Z',
    },
    walletSubjectId: 'wallet_subject_test',
  },
  payloadSha256: 'e'.repeat(64),
  signature: 'signature_test',
  signingPublicKey: REFERENCE,
} satisfies SignedQuoteResponse
const PAYMENT = {
  coverageInstanceId: 'coverage_test',
  outcomeCode: 'activated',
  paymentId: 'payment_test',
  paymentSignature: 'payment_signature',
  providerAgreement: 'agreed',
  quoteId: QUOTE.payload.quoteId,
  status: 'activated',
  submittedAt: '2026-07-28T00:01:00.000Z',
  updatedAt: '2026-07-28T00:01:00.000Z',
} satisfies PaymentResponse
const COVERAGE = {
  activatedAt: '2026-07-28T00:01:00.000Z',
  aggregateLimitMicros: OFFER.aggregateLimitMicros,
  appealWindowDays: OFFER.appealWindowDays,
  coverageEndsAt: '2026-08-27T00:01:00.000Z',
  coverageInstanceId: 'coverage_test',
  coverageStartsAt: '2026-07-28T00:01:00.000Z',
  coveredTransactionLimit: OFFER.coveredTransactionLimit,
  deductibleMicros: OFFER.deductibleMicros,
  delegateLossTailDays: OFFER.delegateLossTailDays,
  immediateLossClaimWindowDays: OFFER.immediateLossClaimWindowDays,
  offerId: OFFER.offerId,
  offerVersion: OFFER.offerVersion,
  paymentId: PAYMENT.paymentId,
  paymentSignature: PAYMENT.paymentSignature,
  perLossLimitMicros: OFFER.perLossLimitMicros,
  policyVersion: OFFER.policyVersion,
  protectedWallet: WALLET,
  quoteId: QUOTE.payload.quoteId,
  status: 'active',
  termsVersion: OFFER.termsVersion,
  waitingPeriodDays: OFFER.waitingPeriodDays,
  walletSubjectId: 'wallet_subject_test',
} satisfies CoverageInstanceResponse

function clientStub() {
  return {
    acceptTerms: vi.fn(async () => ({
      acceptanceId: 'acceptance_test',
      acceptedAt: '2026-07-28T00:00:00.000Z',
      documentSha256: OFFER.termsSha256,
      offerId: OFFER.offerId,
      offerVersion: OFFER.offerVersion,
      termsVersion: OFFER.termsVersion,
      walletSubjectId: 'wallet_subject_test',
    })),
    createPayment: vi.fn(async (request: { paymentSignature: string }) => ({
      ...PAYMENT,
      paymentSignature: request.paymentSignature,
    })),
    createQuote: vi.fn(async () => QUOTE),
    getCoverageInstance: vi.fn(async () => COVERAGE),
    getOffer: vi.fn(async () => OFFER),
    getPayment: vi.fn(async () => PAYMENT),
    listOffers: vi.fn(async () => ({ offers: [OFFER] })),
    verifyQuote: vi.fn(async () => {}),
  }
}

function coverStub(client: ReturnType<typeof clientStub>): EmberLifecycleProvider {
  return {
    activeClient: vi.fn(async () => client),
  } as unknown as EmberLifecycleProvider
}

function rpcStub(options: {
  genesisHash?: string
  onBroadcast?: (transaction: string) => Promise<void>
} = {}): CoveragePaymentRpc {
  return {
    getGenesisHash: () => ({
      send: async () => options.genesisHash ?? MAINNET_GENESIS_HASH,
    }),
    getBalance: () => ({ send: async () => ({ value: 1_000_000n }) }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: REFERENCE,
          lastValidBlockHeight: 100n,
        },
      }),
    }),
    getTokenAccountBalance: () => ({
      send: async () => ({
        value: {
          amount: '5000000',
          decimals: 6,
          uiAmountString: '5',
        },
      }),
    }),
    isBlockhashValid: () => ({ send: async () => ({ value: true }) }),
    simulateTransaction: () => ({
      send: async () => ({
        value: { err: null, fee: 5_000n, logs: ['simulation ok'] },
      }),
    }),
    sendTransaction: (transaction) => ({
      send: async () => {
        await options.onBroadcast?.(String(transaction))
        return getSignatureFromTransaction(
          getTransactionDecoder().decode(
            Uint8Array.from(atob(String(transaction)), (character) =>
              character.charCodeAt(0),
            ),
          ),
        ) as Signature
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [{ confirmationStatus: 'confirmed', err: null }],
      }),
    }),
  }
}

const signer = {
  getAddress: async () => WALLET,
  sign: vi.fn(async () => new Uint8Array(64).fill(7)),
}

beforeEach(() => {
  fakeBrowser.reset()
  vi.restoreAllMocks()
})

test('adds only an exact static read-only quote reference account', () => {
  const instruction = bindQuoteReference(
    {
      accounts: [],
      programAddress: toAddress(TOKEN_PROGRAM),
    },
    toAddress(REFERENCE),
  )
  expect(instruction.accounts).toEqual([
    {
      address: toAddress(REFERENCE),
      role: AccountRole.READONLY,
    },
  ])
})

test('accepts exact terms and creates a server-verified quote before preview', async () => {
  const client = clientStub()
  const provider = new CoveragePaymentProvider(signer, coverStub(client), {
    config: CONFIG,
    now: () => NOW,
    rpcFactory: () => rpcStub(),
  })
  const preview = await provider.previewPayment({
    acceptedTerms: true,
    cluster: 'mainnet-beta',
    offerId: OFFER.offerId,
  })

  expect(client.acceptTerms).toHaveBeenCalledWith({
    documentSha256: OFFER.termsSha256,
    offerId: OFFER.offerId,
    offerVersion: OFFER.offerVersion,
    termsVersion: OFFER.termsVersion,
  })
  expect(client.createQuote).toHaveBeenCalledWith({ offerId: OFFER.offerId })
  expect(preview).toMatchObject({
    quoteId: QUOTE.payload.quoteId,
    quoteReference: REFERENCE,
    simulation: { status: 'success' },
  })
})

test('rejects an RPC whose genesis hash is not the quote-bound Mainnet hash', async () => {
  const client = clientStub()
  const provider = new CoveragePaymentProvider(signer, coverStub(client), {
    config: CONFIG,
    now: () => NOW,
    rpcFactory: () => rpcStub({ genesisHash: 'wrong-network' }),
  })

  await expect(
    provider.previewPayment({
      acceptedTerms: true,
      cluster: 'mainnet-beta',
      offerId: OFFER.offerId,
    }),
  ).rejects.toThrow('not Solana Mainnet')
  expect(signer.sign).not.toHaveBeenCalled()
})

test('persists the signed quote-bound transaction before its first broadcast', async () => {
  const client = clientStub()
  let persistedBeforeBroadcast = false
  const provider = new CoveragePaymentProvider(signer, coverStub(client), {
    config: CONFIG,
    now: () => NOW,
    rpcFactory: () =>
      rpcStub({
        onBroadcast: async (transaction) => {
          const state = await storage.getItem<{
            signedTransactionBase64: string
            status: string
          }>('local:ember-coverage-payment:v3')
          persistedBeforeBroadcast =
            state?.status === 'broadcast_pending' &&
            state.signedTransactionBase64 === transaction
        },
      }),
    statusAttempts: 1,
  })
  const preview = await provider.previewPayment({
    acceptedTerms: true,
    cluster: 'mainnet-beta',
    offerId: OFFER.offerId,
  })
  const result = await provider.activatePayment(preview.quoteId)

  expect(persistedBeforeBroadcast).toBe(true)
  expect(client.verifyQuote).toHaveBeenCalledWith(QUOTE)
  expect(client.createPayment).toHaveBeenCalledWith(
    expect.objectContaining({
      quoteId: QUOTE.payload.quoteId,
    }),
    { idempotencyKey: `payment-${QUOTE.payload.quoteId}` },
  )
  expect(result.coverActive).toBe(true)
  expect(result.state.coverageEndsAt).toBe(COVERAGE.coverageEndsAt)
})
