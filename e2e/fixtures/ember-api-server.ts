import {
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http'
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from 'node:crypto'

import { P11_WALLET_SCOPES } from '@embercover/wallet-sdk'
import type {
  CoverageDecisionResponse,
  CoverageInstanceResponse,
  PaymentResponse,
  QuotePayloadResponse,
  SignedQuoteResponse,
  SubmitDecisionEvidenceRequest,
} from '@embercover/wallet-sdk'

import { base58Encode } from '../../src/crypto/base58.ts'
import { walletChallengeFixture } from '../../src/test/wallet-challenge-fixture.ts'

interface SessionChallenge {
  integrationId: string
  requestedScopes: typeof P11_WALLET_SCOPES
  sessionPublicKey: string
  walletAddress: string
}

export interface EmberApiFixture {
  decisionEvidence: Array<{
    decisionId: string
    request: SubmitDecisionEvidenceRequest
  }>
  origins: Set<string>
  requests: string[]
  rpcTransactions: string[]
  server: Server
}

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const OFFER_ID = 'offer_devnet-qa-core-annual'
const TERMS_VERSION = 'terms-v16.0'
const TERMS_SHA256 = 'd'.repeat(64)
const TREASURY_TOKEN_ACCOUNT = base58Encode(new Uint8Array(32).fill(41))
const TREASURY_OWNER = base58Encode(new Uint8Array(32).fill(42))
const QUOTE_REFERENCE = base58Encode(new Uint8Array(32).fill(43))
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(44))
const CHALLENGE_NONCE = base58Encode(new Uint8Array(24).fill(45))
const QUOTE_SIGNING_KEY_ID = 'quote-key_devnet-qa-e2e'
const PAYMENT_ID = 'payment_devnet-qa-e2e'
const COVERAGE_INSTANCE_ID = 'coverage_devnet-qa-e2e'
const QUOTE_ID = 'quote_devnet-qa-e2e'
const QUOTE_DOMAIN = Buffer.from('ember-signed-quote-v1\0')
const { privateKey: quotePrivateKey, publicKey: quotePublicKey } =
  generateKeyPairSync('ed25519')
const QUOTE_SIGNING_PUBLIC_KEY = base58Encode(
  Buffer.from(quotePublicKey.export({ format: 'der', type: 'spki' })).subarray(-32),
)

const OFFER = {
  aggregateLimitMicros: '120000000000',
  appealWindowDays: 30,
  availabilityMode: 'test',
  benefitPeriodCount: 12,
  benefitPeriodLimitMicros: '10000000000',
  cancellationRuleCode: 'non_refundable',
  catalogueSha256: 'a'.repeat(64),
  cluster: 'devnet',
  coverageDurationDays: 365,
  coverageDurationMonths: 12,
  coveredTransactionLimit: 100,
  deductibleMicros: '0',
  delegateLossTailDays: 7,
  displayName: 'Core Annual — Devnet QA (No real cover)',
  environment: 'sandbox',
  immediateLossClaimWindowDays: 7,
  lifecycle: 'testing',
  offerId: OFFER_ID,
  offerVersion: 1,
  payerMustEqualProtectedWallet: true,
  paymentAsset: 'USDC',
  paymentAssetDecimals: 6,
  paymentMint: DEVNET_USDC_MINT,
  paymentTokenProgram: TOKEN_PROGRAM,
  perLossLimitMicros: '10000000000',
  policySha256: 'b'.repeat(64),
  policyVersion: 'policy-v16.0',
  priceBaseUnits: '1000000',
  productCode: 'core',
  protectedWalletCount: 1,
  refundRuleCode: 'none',
  snapshotSha256: 'c'.repeat(64),
  termsSha256: TERMS_SHA256,
  termsVersion: TERMS_VERSION,
  waitingPeriodDays: 0,
}

function signedQuote(walletAddress: string, issuedAt: Date): SignedQuoteResponse {
  const payload: QuotePayloadResponse = {
    schemaVersion: 3,
    quoteId: QUOTE_ID,
    signingKeyId: QUOTE_SIGNING_KEY_ID,
    mode: 'test',
    partnerId: 'partner_devnet-qa',
    integrationId: 'integration_reference-wallet',
    integrationVersion: 1,
    walletSubjectId: 'wallet_subject_e2e',
    termsAcceptanceId: 'acceptance_devnet-qa-e2e',
    protectedWallet: walletAddress,
    payerWallet: walletAddress,
    offer: {
      snapshotSchemaVersion: 1,
      snapshotSha256: OFFER.snapshotSha256,
      offerId: OFFER.offerId,
      offerVersion: OFFER.offerVersion,
      availabilityId: 'availability_devnet-qa-e2e',
      productCode: OFFER.productCode,
      environment: 'sandbox',
      cluster: 'devnet',
      paymentAsset: OFFER.paymentAsset,
      price: OFFER.priceBaseUnits,
      paymentAssetDecimals: OFFER.paymentAssetDecimals,
      coverageDurationDays: OFFER.coverageDurationDays,
      protectedWalletCount: OFFER.protectedWalletCount,
      payerMustEqualProtectedWallet: OFFER.payerMustEqualProtectedWallet,
      perLossLimit: OFFER.perLossLimitMicros,
      aggregateLimit: OFFER.aggregateLimitMicros,
      coveredTransactionLimit: OFFER.coveredTransactionLimit,
      deductible: OFFER.deductibleMicros,
      waitingPeriodDays: OFFER.waitingPeriodDays,
      immediateLossClaimWindowDays: OFFER.immediateLossClaimWindowDays,
      delegateLossTailDays: OFFER.delegateLossTailDays,
      appealWindowDays: OFFER.appealWindowDays,
      cancellationRuleCode: OFFER.cancellationRuleCode,
      refundRuleCode: OFFER.refundRuleCode,
      termsVersion: OFFER.termsVersion,
      termsHash: OFFER.termsSha256,
      policyVersion: OFFER.policyVersion,
      policyHash: OFFER.policySha256,
      catalogueHash: OFFER.catalogueSha256,
      commission: { kind: 'none' },
      resolvedAt: issuedAt.toISOString(),
    },
    benefitSchedule: {
      coverageDurationMonths: 12,
      benefitPeriodCount: 12,
      benefitPeriodLimit: '10000000000',
    },
    payment: {
      genesisHash: DEVNET_GENESIS_HASH,
      mint: DEVNET_USDC_MINT,
      tokenProgram: TOKEN_PROGRAM,
      treasuryTokenAccount: TREASURY_TOKEN_ACCOUNT,
      treasuryOwner: TREASURY_OWNER,
      amount: '1000000',
      decimals: 6,
      reference: QUOTE_REFERENCE,
    },
    validity: {
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 10 * 60_000).toISOString(),
    },
    nonce: 'nonce_devnet-qa-e2e',
    paymentAllowed: true,
    createsCoverage: true,
  }
  const canonical = Buffer.from(JSON.stringify(payload))
  return {
    payload,
    payloadSha256: createHash('sha256').update(canonical).digest('hex'),
    signingPublicKey: QUOTE_SIGNING_PUBLIC_KEY,
    signature: base58Encode(
      signBytes(null, Buffer.concat([QUOTE_DOMAIN, canonical]), quotePrivateKey),
    ),
  }
}

function paymentResponse(paymentSignature: string, now = new Date()): PaymentResponse {
  return {
    coverageInstanceId: COVERAGE_INSTANCE_ID,
    paymentId: PAYMENT_ID,
    paymentSignature,
    quoteId: QUOTE_ID,
    status: 'activated',
    submittedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

function coverageResponse(
  walletAddress: string,
  paymentSignature: string,
  now = new Date(),
): CoverageInstanceResponse {
  const coverageEndsAt = new Date(now.getTime() + 365 * 24 * 60 * 60_000)
  const currentBenefitPeriodEndsAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000)
  return {
    activatedAt: now.toISOString(),
    aggregateLimitMicros: OFFER.aggregateLimitMicros,
    appealWindowDays: OFFER.appealWindowDays,
    benefitPeriodCount: OFFER.benefitPeriodCount,
    benefitPeriodLimitMicros: OFFER.benefitPeriodLimitMicros,
    coverageEndsAt: coverageEndsAt.toISOString(),
    coverageInstanceId: COVERAGE_INSTANCE_ID,
    coverageStartsAt: now.toISOString(),
    coveredTransactionLimit: OFFER.coveredTransactionLimit,
    currentBenefitPeriodEndsAt: currentBenefitPeriodEndsAt.toISOString(),
    currentBenefitPeriodOrdinal: 1,
    currentBenefitPeriodStartsAt: now.toISOString(),
    deductibleMicros: OFFER.deductibleMicros,
    delegateLossTailDays: OFFER.delegateLossTailDays,
    immediateLossClaimWindowDays: OFFER.immediateLossClaimWindowDays,
    offerId: OFFER.offerId,
    offerVersion: OFFER.offerVersion,
    paymentId: PAYMENT_ID,
    paymentSignature,
    perLossLimitMicros: OFFER.perLossLimitMicros,
    policyVersion: OFFER.policyVersion,
    protectedWallet: walletAddress,
    quoteId: QUOTE_ID,
    remainingBenefitPeriodLimitMicros: OFFER.benefitPeriodLimitMicros,
    status: 'active',
    termsVersion: OFFER.termsVersion,
    waitingPeriodDays: OFFER.waitingPeriodDays,
    walletSubjectId: 'wallet_subject_e2e',
  }
}

function decisionResponse(
  decisionId: string,
  kind: 'message' | 'transaction',
  walletAddress: string,
  now = new Date(),
): CoverageDecisionResponse {
  return {
    coverStatus: 'covered',
    coverageInstanceId: COVERAGE_INSTANCE_ID,
    decisionExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    decisionId,
    decisionReason: 'eligible',
    evaluationCountImpact: 1,
    evidenceState: 'pre_sign',
    kind,
    maximumPayoutMicros: OFFER.perLossLimitMicros,
    offerId: OFFER.offerId,
    offerVersion: OFFER.offerVersion,
    policyVersion: OFFER.policyVersion,
    protectedWallet: walletAddress,
    quoteId: QUOTE_ID,
    remainingAggregateLimitMicros: OFFER.aggregateLimitMicros,
    remainingUnderwritingEvaluations: OFFER.coveredTransactionLimit - 1,
    riskBand: 'low',
    termsVersion: OFFER.termsVersion,
  }
}

function transactionSignature(transactionBase64: string): string {
  const bytes = Buffer.from(transactionBase64, 'base64')
  if (bytes.length < 65 || bytes[0] !== 1) {
    throw new Error('Expected one signature in the signed test transaction')
  }
  return base58Encode(bytes.subarray(1, 65))
}

function hasExpectedWalletScopes(value: unknown): value is typeof P11_WALLET_SCOPES {
  return (
    Array.isArray(value) &&
    value.length === P11_WALLET_SCOPES.length &&
    value.every((scope, index) => scope === P11_WALLET_SCOPES[index])
  )
}

function rpcResponse(
  res: ServerResponse,
  id: unknown,
  result: unknown,
  origin: string | undefined,
): void {
  response(res, 200, { jsonrpc: '2.0', id, result }, origin)
}

function response(
  res: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
): void {
  res.writeHead(status, {
    'access-control-allow-headers':
      'content-type,idempotency-key,x-ember-wallet-jti,x-ember-wallet-session,x-ember-wallet-signature,x-ember-wallet-timestamp',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
    'content-type': 'application/json',
  })
  res.end(JSON.stringify(body))
}

/** Deterministic direct-SDK fixture. It has no partner key and no compatibility routes. */
export function startEmberApiFixture(port = 18787): Promise<EmberApiFixture> {
  const decisionEvidence: EmberApiFixture['decisionEvidence'] = []
  const origins = new Set<string>()
  const requests: string[] = []
  const rpcTransactions: string[] = []
  const decisions = new Map<string, CoverageDecisionResponse>()
  let decisionSequence = 0
  let challenge: SessionChallenge | null = null
  let activatedPayment: PaymentResponse | null = null
  let sessionOrigin: string | null = null
  const server = createServer((req, res) => {
    void (async () => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
      if (origin) origins.add(origin)
      requests.push(`${req.method ?? 'UNKNOWN'} ${req.url ?? '/'} origin=${origin ?? 'none'}`)
      if (req.method === 'OPTIONS') {
        response(res, 204, {}, origin)
        return
      }
      if (req.headers['x-ember-wallet-session']) {
        const exactOriginMatches = origin !== undefined && origin === sessionOrigin
        const chromeOmittedOrigin =
          req.method === 'GET' &&
          origin === undefined &&
          sessionOrigin?.startsWith('chrome-extension://') === true
        if (!exactOriginMatches && !chromeOmittedOrigin) {
          response(res, 403, { error: 'wallet_client_binding_mismatch' }, origin)
          return
        }
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const bodyText = Buffer.concat(chunks).toString('utf8')
      const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}
      const path = req.url ?? '/'

      if (req.method === 'POST' && path === '/' && typeof body.method === 'string') {
        const context = { apiVersion: '2.2.7', slot: 123_456 }
        const rpcParams = Array.isArray(body.params) ? body.params : []
        const result = (() => {
          switch (body.method) {
            case 'getGenesisHash':
              return DEVNET_GENESIS_HASH
            case 'getBalance':
              return { context, value: 1_000_000_000 }
            case 'getAccountInfo':
              return {
                context,
                value: {
                  data: ['', 'base64'],
                  executable: false,
                  lamports: 2_039_280,
                  owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                  rentEpoch: 0,
                  space: 165,
                },
              }
            case 'getSignaturesForAddress':
              return []
            case 'getTokenAccountsByOwner':
              return { context, value: [] }
            case 'getTokenAccountBalance':
              return {
                context,
                value: {
                  amount: '5000000',
                  decimals: 6,
                  uiAmount: 5,
                  uiAmountString: '5',
                },
              }
            case 'getLatestBlockhash':
              return {
                context,
                value: {
                  blockhash: BLOCKHASH,
                  lastValidBlockHeight: 200_000,
                },
              }
            case 'simulateTransaction':
              return {
                context,
                value: {
                  accounts: null,
                  err: null,
                  fee: 5_000,
                  logs: ['Program log: Devnet QA simulation only', 'Program success'],
                  replacementBlockhash: null,
                  returnData: null,
                  unitsConsumed: 12_345,
                },
              }
            case 'getBlockHeight':
              return 123_456
            case 'isBlockhashValid':
              return { context, value: true }
            case 'sendTransaction': {
              const signedTransaction = String(rpcParams[0] ?? '')
              const signature = transactionSignature(signedTransaction)
              rpcTransactions.push(signedTransaction)
              return signature
            }
            case 'getSignatureStatuses':
              return {
                context,
                value: (Array.isArray(rpcParams[0]) ? rpcParams[0] : []).map(() => ({
                  confirmationStatus: 'finalized',
                  confirmations: null,
                  err: null,
                  slot: 123_456,
                  status: { Ok: null },
                })),
              }
            default:
              return null
          }
        })()
        rpcResponse(res, body.id, result, origin)
        return
      }

      if (req.method === 'POST' && path === '/v1/wallet-sessions/challenges') {
        if (
          !origin ||
          !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
          typeof body.integrationId !== 'string' ||
          !hasExpectedWalletScopes(body.requestedScopes) ||
          typeof body.sessionPublicKey !== 'string' ||
          typeof body.walletAddress !== 'string'
        ) {
          response(res, 403, { error: 'wallet_client_binding_mismatch' }, origin)
          return
        }
        const issuedAt = new Date()
        sessionOrigin = origin
        challenge = {
          integrationId: body.integrationId,
          requestedScopes: body.requestedScopes,
          sessionPublicKey: body.sessionPublicKey,
          walletAddress: body.walletAddress,
        }
        response(
          res,
          200,
          walletChallengeFixture({
            challengeId: 'challenge_e2e',
            extensionOrigin: origin,
            integrationId: challenge.integrationId,
            integrationVersion: 1,
            issuedAt,
            nonce: CHALLENGE_NONCE,
            requestedScopes: challenge.requestedScopes,
            sessionPublicKey: challenge.sessionPublicKey,
            walletAddress: challenge.walletAddress,
          }),
          origin,
        )
        return
      }
      if (req.method === 'POST' && path === '/v1/wallet-sessions') {
        if (!challenge || origin !== sessionOrigin) {
          response(res, 409, { error: 'challenge_missing' }, origin)
          return
        }
        const issuedAt = new Date()
        response(
          res,
          200,
          {
            environment: 'sandbox',
            expiresAt: new Date(issuedAt.getTime() + 15 * 60_000).toISOString(),
            integrationId: challenge.integrationId,
            integrationVersion: 1,
            partnerId: 'partner_devnet-qa',
            refreshExpiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60_000).toISOString(),
            refreshToken: 'refresh_session_e2e.redacted',
            scopes: [...P11_WALLET_SCOPES],
            sessionId: 'session_e2e',
            walletAddress: challenge.walletAddress,
            walletSubjectId: 'wallet_subject_e2e',
          },
          origin,
        )
        return
      }
      if (req.method === 'GET' && path === '/v1/wallet/offers') {
        response(res, 200, { offers: [OFFER] }, origin)
        return
      }
      if (req.method === 'GET' && path === `/v1/wallet/offers/${OFFER_ID}`) {
        response(res, 200, OFFER, origin)
        return
      }
      if (req.method === 'POST' && path === '/v1/wallet/terms-acceptances') {
        response(
          res,
          200,
          {
            acceptanceId: 'acceptance_devnet-qa-e2e',
            acceptedAt: new Date().toISOString(),
            documentSha256: TERMS_SHA256,
            offerId: OFFER_ID,
            offerVersion: 1,
            termsVersion: TERMS_VERSION,
            walletSubjectId: 'wallet_subject_e2e',
          },
          origin,
        )
        return
      }
      if (req.method === 'POST' && path === '/v1/quotes') {
        if (!challenge) {
          response(res, 409, { error: 'challenge_missing' }, origin)
          return
        }
        // Keep the preparation stage observable in the packaged-wallet behavior test.
        await new Promise((resolve) => setTimeout(resolve, 100))
        response(res, 200, signedQuote(challenge.walletAddress, new Date()), origin)
        return
      }
      if (req.method === 'GET' && path === '/v1/quote-signing-keys') {
        const now = new Date().toISOString()
        response(
          res,
          200,
          {
            keys: [
              {
                algorithm: 'ed25519',
                createdAt: now,
                keyId: QUOTE_SIGNING_KEY_ID,
                mode: 'test',
                publicKey: QUOTE_SIGNING_PUBLIC_KEY,
                state: 'active',
                updatedAt: now,
              },
            ],
          },
          origin,
        )
        return
      }
      if (req.method === 'POST' && path === '/v1/payments') {
        if (!challenge || body.quoteId !== QUOTE_ID || typeof body.paymentSignature !== 'string') {
          response(res, 409, { error: 'payment_mismatch' }, origin)
          return
        }
        activatedPayment = paymentResponse(body.paymentSignature)
        response(res, 200, activatedPayment, origin)
        return
      }
      if (req.method === 'GET' && path === `/v1/payments/${PAYMENT_ID}`) {
        if (!activatedPayment) {
          response(res, 404, { error: 'payment_not_found' }, origin)
          return
        }
        response(res, 200, activatedPayment, origin)
        return
      }
      if (req.method === 'GET' && path === `/v1/coverage-instances/${COVERAGE_INSTANCE_ID}`) {
        if (!challenge || !activatedPayment) {
          response(res, 404, { error: 'coverage_not_found' }, origin)
          return
        }
        response(
          res,
          200,
          coverageResponse(challenge.walletAddress, activatedPayment.paymentSignature),
          origin,
        )
        return
      }
      if (req.method === 'POST' && path === '/v1/decisions') {
        if (
          !challenge ||
          !activatedPayment ||
          body.coverageInstanceId !== COVERAGE_INSTANCE_ID ||
          (body.kind !== 'transaction' && body.kind !== 'message')
        ) {
          response(res, 409, { error: 'decision_mismatch' }, origin)
          return
        }
        decisionSequence += 1
        const decision = decisionResponse(
          `decision_devnet-qa-e2e-${decisionSequence}`,
          body.kind,
          challenge.walletAddress,
        )
        decisions.set(decision.decisionId, decision)
        response(res, 200, decision, origin)
        return
      }
      const decisionMatch = path.match(/^\/v1\/decisions\/([^/]+)$/)
      if (req.method === 'GET' && decisionMatch) {
        const decision = decisions.get(decodeURIComponent(decisionMatch[1] ?? ''))
        if (!decision) {
          response(res, 404, { error: 'decision_not_found' }, origin)
          return
        }
        response(res, 200, decision, origin)
        return
      }
      const lineageMatch = path.match(/^\/v1\/decisions\/([^/]+)\/lineage$/)
      if (req.method === 'GET' && lineageMatch) {
        const decisionId = decodeURIComponent(lineageMatch[1] ?? '')
        const decision = decisions.get(decisionId)
        if (!decision) {
          response(res, 404, { error: 'decision_not_found' }, origin)
          return
        }
        response(
          res,
          200,
          {
            coverageInstanceId: COVERAGE_INSTANCE_ID,
            decisionId,
            evidenceState: decision.evidenceState,
            lifecycle: [{ occurredAt: new Date().toISOString(), status: 'reviewed' }],
            paymentId: PAYMENT_ID,
            quoteId: QUOTE_ID,
          },
          origin,
        )
        return
      }
      const evidenceMatch = path.match(/^\/v1\/decisions\/([^/]+)\/post-sign$/)
      if (req.method === 'POST' && evidenceMatch) {
        const decisionId = decodeURIComponent(evidenceMatch[1] ?? '')
        const decision = decisions.get(decisionId)
        if (!decision || body.kind !== decision.kind) {
          response(res, 409, { error: 'evidence_mismatch' }, origin)
          return
        }
        let evidence: SubmitDecisionEvidenceRequest
        if (body.kind === 'transaction' && typeof body.signedBytes === 'string') {
          evidence = { kind: 'transaction', signedBytes: body.signedBytes }
        } else if (
          body.kind === 'message' &&
          typeof body.signature === 'string' &&
          typeof body.signedMessage === 'string'
        ) {
          evidence = {
            kind: 'message',
            signature: body.signature,
            signedMessage: body.signedMessage,
          }
        } else {
          response(res, 400, { error: 'invalid_evidence' }, origin)
          return
        }
        decisionEvidence.push({ decisionId, request: evidence })
        decisions.set(decisionId, { ...decision, evidenceState: 'post_sign' })
        response(
          res,
          200,
          {
            accepted: true,
            decisionId,
            evidenceState: 'post_sign',
            ...(evidence.kind === 'transaction'
              ? { transactionSignature: transactionSignature(evidence.signedBytes) }
              : {}),
          },
          origin,
        )
        return
      }
      if (req.method === 'GET' && path === '/v1/wallet/claims') {
        response(res, 200, { claims: [] }, origin)
        return
      }
      if (req.method === 'POST' && path === '/v1/wallet-sessions/revoke') {
        response(res, 200, { revokedSessions: 1 }, origin)
        return
      }
      response(
        res,
        404,
        {
          details: [],
          error: 'invalid_request',
          message: `No E2E route for ${req.method} ${path}`,
          requestId: 'request_e2e_missing',
        },
        origin,
      )
    })().catch((error) => {
      response(res, 500, { error: String(error) }, undefined)
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ decisionEvidence, origins, requests, rpcTransactions, server }),
    )
  })
}
