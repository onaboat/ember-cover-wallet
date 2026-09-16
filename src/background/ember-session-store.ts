import {
  parsePersistedWalletSession,
  type PersistedWalletSession,
  type WalletSessionStore,
} from '@embercover/wallet-sdk'
import { storage } from 'wxt/utils/storage'

const SESSION_KEY = 'local:ember-wallet-session:v1' as const

export class BrowserWalletSessionStore implements WalletSessionStore {
  async load(): Promise<PersistedWalletSession | null> {
    const stored = await storage.getItem<unknown>(SESSION_KEY)
    const session = parsePersistedWalletSession(stored)
    if (!session) {
      if (stored !== null) await storage.removeItem(SESSION_KEY)
      return null
    }
    return session
  }

  async save(session: PersistedWalletSession): Promise<void> {
    await storage.setItem(SESSION_KEY, session)
  }

  async clear(): Promise<void> {
    await storage.removeItem(SESSION_KEY)
  }
}

export const browserWalletSessionStore = new BrowserWalletSessionStore()
