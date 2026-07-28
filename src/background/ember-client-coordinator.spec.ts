import { P11_WALLET_SCOPES } from '@embercover/wallet-sdk'
import type {
  PersistedWalletSession,
  WalletSessionStore,
} from '@embercover/wallet-sdk'
import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test, vi } from 'vitest'

import type { EmberRuntimeConfig } from '../cover/ember-config.ts'

import { EmberClientCoordinator } from './ember-client-coordinator.ts'

const WALLET = 'So11111111111111111111111111111111111111112'
const NOW = new Date('2026-07-28T00:00:00.000Z')
const CONFIG: EmberRuntimeConfig = {
  apiBaseUrl: 'http://127.0.0.1:18787',
  environment: 'sandbox',
  expectedCluster: 'devnet',
  expectedGenesisHash: null,
  extensionId: null,
  integrationId: 'integration_reference-wallet',
  problems: [],
}

class MemorySessionStore implements WalletSessionStore {
  value: PersistedWalletSession | null = null

  async load() {
    return this.value
  }

  async save(session: PersistedWalletSession) {
    this.value = session
  }

  async clear() {
    this.value = null
  }
}

function sessionResponse(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'sandbox',
    expiresAt: '2026-07-28T00:15:00.000Z',
    integrationId: CONFIG.integrationId,
    integrationVersion: 1,
    partnerId: 'partner_test',
    refreshExpiresAt: '2026-07-29T00:00:00.000Z',
    refreshToken: 'refresh_session_test.redacted',
    scopes: [...P11_WALLET_SCOPES],
    sessionId: 'session_test',
    walletAddress: WALLET,
    walletSubjectId: 'wallet_subject_test',
    ...overrides,
  }
}

function sessionFetch(options: {
  expiresAt?: string
  onRequest?: (url: string, init: RequestInit | undefined) => void
} = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    options.onRequest?.(url, init)
    if (url.endsWith('/v1/wallet-sessions/challenges')) {
      return Response.json({
        challengeId: 'challenge_test',
        expiresAt: '2026-07-28T00:05:00.000Z',
        issuedAt: NOW.toISOString(),
        message: 'Sign exact Ember challenge',
        nonce: 'nonce_test',
      })
    }
    if (url.endsWith('/v1/wallet-sessions/rotate')) {
      const body = JSON.parse(String(init?.body)) as { sessionPublicKey: string }
      return Response.json(
        sessionResponse({
          expiresAt: '2026-07-28T00:30:00.000Z',
          refreshToken: 'refresh_session_rotated.redacted',
          sessionId: 'session_rotated',
        }),
      )
    }
    if (url.endsWith('/v1/wallet-sessions/revoke')) {
      return Response.json({ revokedSessions: 1 })
    }
    if (url.endsWith('/v1/wallet-sessions')) {
      return Response.json(
        sessionResponse({
          ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        }),
      )
    }
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch
}

const vaultSigner = {
  getAddress: async () => WALLET,
  sign: vi.fn(async () => new Uint8Array(64).fill(7)),
}

beforeEach(() => {
  fakeBrowser.reset()
  vi.restoreAllMocks()
})

test('opens a least-privilege SDK session with the vault challenge signer', async () => {
  const store = new MemorySessionStore()
  let challengeBody: Record<string, unknown> | null = null
  const coordinator = new EmberClientCoordinator(vaultSigner, {
    config: CONFIG,
    fetch: sessionFetch({
      onRequest: (url, init) => {
        if (url.endsWith('/v1/wallet-sessions/challenges')) {
          challengeBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        }
      },
    }),
    now: () => NOW,
    sessionStore: store,
  })

  await coordinator.enroll()

  expect(challengeBody).toMatchObject({
    client: { kind: 'browser' },
    integrationId: CONFIG.integrationId,
    requestedScopes: [...P11_WALLET_SCOPES],
    walletAddress: WALLET,
  })
  expect(vaultSigner.sign).toHaveBeenCalledOnce()
  expect(store.value?.sessionPublicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/)
})

test('restores the scoped session after a service-worker restart', async () => {
  const store = new MemorySessionStore()
  const fetchAdapter = sessionFetch()
  const first = new EmberClientCoordinator(vaultSigner, {
    config: CONFIG,
    fetch: fetchAdapter,
    now: () => NOW,
    sessionStore: store,
  })
  await first.enroll()
  const restarted = new EmberClientCoordinator(vaultSigner, {
    config: CONFIG,
    fetch: fetchAdapter,
    now: () => NOW,
    sessionStore: store,
  })

  expect(await restarted.activeClient()).not.toBeNull()
  expect((await restarted.status()).phase).toBe('active')
})

test('rotates the API-only key before access expiry and promotes the accepted key', async () => {
  const store = new MemorySessionStore()
  const fetchAdapter = sessionFetch({ expiresAt: '2026-07-28T00:01:00.000Z' })
  const coordinator = new EmberClientCoordinator(vaultSigner, {
    config: CONFIG,
    fetch: fetchAdapter,
    now: () => NOW,
    sessionStore: store,
  })
  await coordinator.enroll()
  const firstPublicKey = store.value?.sessionPublicKey

  expect(await coordinator.activeClient()).not.toBeNull()
  expect(store.value?.sessionId).toBe('session_rotated')
  expect(store.value?.sessionPublicKey).not.toBe(firstPublicKey)
})

test('does not silently use an expired access session', async () => {
  const store = new MemorySessionStore()
  const coordinator = new EmberClientCoordinator(vaultSigner, {
    config: CONFIG,
    fetch: sessionFetch({ expiresAt: '2026-07-27T23:59:00.000Z' }),
    now: () => NOW,
    sessionStore: store,
  })
  await coordinator.enroll()

  expect(await coordinator.activeClient()).toBeNull()
  expect((await coordinator.status()).phase).toBe('renewal_required')
})

test('revocation clears the local refresh credential even after the server call', async () => {
  const store = new MemorySessionStore()
  const coordinator = new EmberClientCoordinator(vaultSigner, {
    config: CONFIG,
    fetch: sessionFetch(),
    now: () => NOW,
    sessionStore: store,
  })
  await coordinator.enroll()
  await coordinator.revoke()

  expect(store.value).toBeNull()
  expect((await coordinator.status()).phase).toBe('disconnected')
})
