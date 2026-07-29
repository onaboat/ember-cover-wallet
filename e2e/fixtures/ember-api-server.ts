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
import type { QuotePayloadResponse, SignedQuoteResponse } from '@embercover/wallet-sdk'

import { base58Encode } from '../../src/crypto/base58.ts'

interface SessionChallenge {
  integrationId: string
  sessionPublicKey: string
  walletAddress: string
}

export interface EmberApiFixture {
  origins: Set<string>
  requests: string[]
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
const QUOTE_SIGNING_KEY_ID = 'quote-key_devnet-qa-e2e'
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
    quoteId: 'quote_devnet-qa-e2e',
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
  const origins = new Set<string>()
  const requests: string[] = []
  let challenge: SessionChallenge | null = null
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
        const result = (() => {
          switch (body.method) {
            case 'getGenesisHash':
              return DEVNET_GENESIS_HASH
            case 'getBalance':
              return { context, value: 1_000_000_000 }
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
            case 'getSignatureStatuses':
              return { context, value: [] }
            default:
              return null
          }
        })()
        rpcResponse(res, body.id, result, origin)
        return
      }

      if (req.method === 'POST' && path === '/v1/wallet-sessions/challenges') {
        if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
          response(res, 403, { error: 'wallet_client_binding_mismatch' }, origin)
          return
        }
        const issuedAt = new Date()
        sessionOrigin = origin
        challenge = {
          integrationId: String(body.integrationId),
          sessionPublicKey: String(body.sessionPublicKey),
          walletAddress: String(body.walletAddress),
        }
        response(
          res,
          200,
          {
            challengeId: 'challenge_e2e',
            expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
            issuedAt: issuedAt.toISOString(),
            message: 'Ember E2E exact wallet challenge',
            nonce: 'nonce_e2e',
          },
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
    server.listen(port, '127.0.0.1', () => resolve({ origins, requests, server }))
  })
}
