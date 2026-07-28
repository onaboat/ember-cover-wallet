import {
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http'

import { P11_WALLET_SCOPES } from '@embercover/wallet-sdk'

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

const OFFER = {
  aggregateLimitMicros: '10000000000',
  appealWindowDays: 30,
  availabilityMode: 'test',
  cancellationRuleCode: 'non_refundable',
  catalogueSha256: 'a'.repeat(64),
  cluster: 'devnet',
  coverageDurationDays: 30,
  coveredTransactionLimit: 100,
  deductibleMicros: '0',
  delegateLossTailDays: 7,
  displayName: 'Core sandbox',
  environment: 'sandbox',
  immediateLossClaimWindowDays: 7,
  lifecycle: 'testing',
  offerId: 'offer_sandbox_core',
  offerVersion: 1,
  payerMustEqualProtectedWallet: true,
  paymentAsset: 'USDC',
  paymentAssetDecimals: 6,
  paymentMint: null,
  paymentTokenProgram: null,
  perLossLimitMicros: '1000000000',
  policySha256: 'b'.repeat(64),
  policyVersion: 'policy-sandbox-v1',
  priceBaseUnits: '0',
  productCode: 'core',
  protectedWalletCount: 1,
  refundRuleCode: 'none',
  snapshotSha256: 'c'.repeat(64),
  termsSha256: 'd'.repeat(64),
  termsVersion: 'terms-sandbox-v1',
  waitingPeriodDays: 0,
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
            partnerId: 'partner_e2e',
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
