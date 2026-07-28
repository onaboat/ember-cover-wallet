import type {
  PersistedWalletSession,
  WalletSessionStore,
} from '@embercover/wallet-sdk'
import { storage } from 'wxt/utils/storage'

const SESSION_KEY = 'local:ember-wallet-session:v1' as const

function isPersistedSession(value: unknown): value is PersistedWalletSession {
  if (!value || typeof value !== 'object') return false
  const session = value as Partial<PersistedWalletSession>
  return (
    typeof session.sessionId === 'string' &&
    typeof session.sessionPublicKey === 'string' &&
    typeof session.walletAddress === 'string' &&
    typeof session.walletSubjectId === 'string' &&
    typeof session.integrationId === 'string' &&
    typeof session.environment === 'string' &&
    typeof session.expiresAt === 'string' &&
    typeof session.refreshExpiresAt === 'string' &&
    typeof session.refreshToken === 'string' &&
    Array.isArray(session.scopes)
  )
}

export class BrowserWalletSessionStore implements WalletSessionStore {
  async load(): Promise<PersistedWalletSession | null> {
    const stored = await storage.getItem<unknown>(SESSION_KEY)
    if (!isPersistedSession(stored)) {
      if (stored !== null) await storage.removeItem(SESSION_KEY)
      return null
    }
    return stored
  }

  async save(session: PersistedWalletSession): Promise<void> {
    await storage.setItem(SESSION_KEY, session)
  }

  async clear(): Promise<void> {
    await storage.removeItem(SESSION_KEY)
  }
}

export const browserWalletSessionStore = new BrowserWalletSessionStore()
