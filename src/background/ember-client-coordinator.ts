import {
  EmberWalletClient,
  P11_WALLET_SCOPES,
} from '@embercover/wallet-sdk'
import { browser } from 'wxt/browser'
import type {
  EmberFetch,
  PersistedWalletSession,
  WalletSessionStore,
} from '@embercover/wallet-sdk'

import {
  EMBER_CONFIG,
} from '../cover/ember-config.ts'
import type { EmberRuntimeConfig } from '../cover/ember-config.ts'

import { browserWalletSessionStore } from './ember-session-store.ts'
import {
  discardPendingSessionSigner,
  getSessionSigner,
  prepareNextSessionSigner,
  promoteSessionSigner,
} from './session-key.ts'

const ROTATE_BEFORE_EXPIRY_MS = 2 * 60 * 1_000

export interface EmberVaultSigner {
  getAddress(): Promise<string | null>
  sign(message: Uint8Array): Promise<Uint8Array>
}

export interface EmberSessionStatus {
  environment: EmberRuntimeConfig['environment']
  expiresAt: string | null
  phase:
    | 'configuration_required'
    | 'disconnected'
    | 'active'
    | 'renewal_required'
    | 'wallet_mismatch'
  refreshExpiresAt: string | null
  walletAddress: string | null
  walletSubjectId: string | null
  problems: string[]
}

interface CoordinatorDependencies {
  config?: EmberRuntimeConfig
  fetch?: EmberFetch
  now?: () => Date
  sessionStore?: WalletSessionStore
}

/**
 * Owns the SDK session lifecycle inside the extension service worker.
 *
 * The vault signs only the one-time server challenge. Every later API request
 * is signed by the scoped, ephemeral session key, which cannot move funds.
 */
export class EmberClientCoordinator {
  private readonly config: EmberRuntimeConfig
  private readonly fetchAdapter: EmberFetch | undefined
  private readonly now: () => Date
  private readonly sessionStore: WalletSessionStore
  private readonly vaultSigner: EmberVaultSigner
  private operation: Promise<unknown> = Promise.resolve()

  constructor(
    vaultSigner: EmberVaultSigner,
    dependencies: CoordinatorDependencies = {},
  ) {
    this.vaultSigner = vaultSigner
    this.config = dependencies.config ?? EMBER_CONFIG
    this.fetchAdapter = dependencies.fetch
    this.now = dependencies.now ?? (() => new Date())
    this.sessionStore = dependencies.sessionStore ?? browserWalletSessionStore
  }

  async enroll(): Promise<PersistedWalletSession> {
    return await this.serialized(async () => {
      this.assertConfigured()
      const walletAddress = await this.requireWalletAddress()
      const existing = await this.sessionStore.load()
      if (existing && existing.walletAddress !== walletAddress) {
        await this.sessionStore.clear()
      }
      const signer = await getSessionSigner()
      const client = this.createClient(signer)
      return await client.openSession({
        requestedScopes: P11_WALLET_SCOPES,
        walletSigner: {
          publicKey: walletAddress,
          signMessage: (message) => this.vaultSigner.sign(message),
        },
      })
    })
  }

  async activeClient(): Promise<EmberWalletClient | null> {
    return await this.serialized(async () => {
      if (this.configurationProblems().length > 0) return null
      const session = await this.sessionStore.load()
      const walletAddress = await this.vaultSigner.getAddress()
      if (!session || !walletAddress || session.walletAddress !== walletAddress) return null
      const now = this.now().getTime()
      if (now >= Date.parse(session.expiresAt)) return null
      const signer = await getSessionSigner(session.sessionPublicKey)
      const client = this.createClient(signer)
      if (Date.parse(session.expiresAt) - now > ROTATE_BEFORE_EXPIRY_MS) return client

      const nextSigner = await prepareNextSessionSigner()
      try {
        await client.rotateSession(nextSigner)
        await promoteSessionSigner(nextSigner.publicKey)
        return this.createClient(nextSigner)
      } catch {
        const persisted = await this.sessionStore.load()
        if (persisted?.sessionPublicKey === nextSigner.publicKey) {
          // The SDK persisted the accepted server session before local key
          // promotion. Recover that exact pending key after an interrupted write.
          const recovered = await getSessionSigner(nextSigner.publicKey)
          return this.createClient(recovered)
        }
        await discardPendingSessionSigner()
        return client
      }
    })
  }

  async revoke(): Promise<void> {
    await this.serialized(async () => {
      const session = await this.sessionStore.load()
      if (!session) return
      try {
        const signer = await getSessionSigner(session.sessionPublicKey)
        await this.createClient(signer).revokeSession({ reason: 'user_requested' })
      } finally {
        await this.sessionStore.clear()
        await discardPendingSessionSigner()
      }
    })
  }

  async status(): Promise<EmberSessionStatus> {
    const walletAddress = await this.vaultSigner.getAddress()
    const problems = this.configurationProblems()
    if (problems.length > 0) {
      return {
        environment: this.config.environment,
        expiresAt: null,
        phase: 'configuration_required',
        refreshExpiresAt: null,
        walletAddress,
        walletSubjectId: null,
        problems,
      }
    }
    const session = await this.sessionStore.load()
    if (!session) {
      return {
        environment: this.config.environment,
        expiresAt: null,
        phase: 'disconnected',
        refreshExpiresAt: null,
        walletAddress,
        walletSubjectId: null,
        problems: [],
      }
    }
    if (!walletAddress || session.walletAddress !== walletAddress) {
      return {
        environment: this.config.environment,
        expiresAt: session.expiresAt,
        phase: 'wallet_mismatch',
        refreshExpiresAt: session.refreshExpiresAt,
        walletAddress,
        walletSubjectId: session.walletSubjectId,
        problems: ['The Ember session belongs to a different wallet'],
      }
    }
    const now = this.now().getTime()
    return {
      environment: this.config.environment,
      expiresAt: session.expiresAt,
      phase: now < Date.parse(session.expiresAt) ? 'active' : 'renewal_required',
      refreshExpiresAt: session.refreshExpiresAt,
      walletAddress,
      walletSubjectId: session.walletSubjectId,
      problems: [],
    }
  }

  private assertConfigured(): void {
    const problems = this.configurationProblems()
    if (!this.config.apiBaseUrl || !this.config.integrationId || problems.length > 0) {
      throw new Error(problems.join('; ') || 'Ember is not configured')
    }
  }

  private configurationProblems(): string[] {
    const problems = [...this.config.problems]
    if (
      this.config.extensionId &&
      browser.runtime.id &&
      browser.runtime.id !== this.config.extensionId
    ) {
      problems.push(
        `Installed extension ID ${browser.runtime.id} does not match the approved Ember origin`,
      )
    }
    return problems
  }

  private createClient(
    signer: Awaited<ReturnType<typeof getSessionSigner>>,
  ): EmberWalletClient {
    this.assertConfigured()
    return new EmberWalletClient({
      baseUrl: this.config.apiBaseUrl!,
      client: { kind: 'browser' },
      environment: this.config.environment,
      integrationId: this.config.integrationId!,
      now: this.now,
      sessionSigner: signer,
      sessionStore: this.sessionStore,
      ...(this.fetchAdapter ? { fetch: this.fetchAdapter } : {}),
    })
  }

  private async requireWalletAddress(): Promise<string> {
    const walletAddress = await this.vaultSigner.getAddress()
    if (!walletAddress) throw new Error('Create or import a wallet before connecting Ember')
    return walletAddress
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operation.then(operation, operation)
    this.operation = current.then(
      () => undefined,
      () => undefined,
    )
    return await current
  }
}
