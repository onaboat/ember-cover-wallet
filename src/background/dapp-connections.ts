import { storage } from 'wxt/utils/storage'

const STORE_KEY = 'local:ember-dapp-connections' as const

export interface DappConnection {
  origin: string
  address: string
  connectedAt: string
  lastSeenAt: string
}

interface DappConnectionStoreDeps {
  now?: () => Date
}

function isConnection(value: unknown): value is DappConnection {
  if (!value || typeof value !== 'object') {
    return false
  }
  const connection = value as Record<string, unknown>
  return (
    typeof connection.origin === 'string' &&
    typeof connection.address === 'string' &&
    typeof connection.connectedAt === 'string' &&
    typeof connection.lastSeenAt === 'string'
  )
}

export class DappConnectionStore {
  #now: () => Date

  constructor(deps: DappConnectionStoreDeps = {}) {
    this.#now = deps.now ?? (() => new Date())
  }

  async authorize(origin: string, address: string): Promise<DappConnection> {
    const connections = await this.#read()
    const timestamp = this.#now().toISOString()
    const existing = connections.find((connection) => connection.origin === origin)
    const next: DappConnection = {
      origin,
      address,
      connectedAt: existing?.connectedAt ?? timestamp,
      lastSeenAt: timestamp,
    }
    await this.#write([...connections.filter((connection) => connection.origin !== origin), next])
    return next
  }

  async get(origin: string, currentAddress: string | null): Promise<DappConnection | null> {
    if (!currentAddress) {
      return null
    }
    const connections = await this.#read()
    const existing = connections.find((connection) => connection.origin === origin)
    if (!existing) {
      return null
    }
    if (existing.address !== currentAddress) {
      await this.disconnect(origin)
      return null
    }
    const next: DappConnection = {
      ...existing,
      lastSeenAt: this.#now().toISOString(),
    }
    await this.#write([...connections.filter((connection) => connection.origin !== origin), next])
    return next
  }

  async disconnect(origin: string): Promise<void> {
    const connections = await this.#read()
    await this.#write(connections.filter((connection) => connection.origin !== origin))
  }

  async list(): Promise<DappConnection[]> {
    return await this.#read()
  }

  async #read(): Promise<DappConnection[]> {
    const stored = await storage.getItem<unknown>(STORE_KEY)
    return Array.isArray(stored) ? stored.filter(isConnection) : []
  }

  async #write(connections: DappConnection[]): Promise<void> {
    if (connections.length === 0) {
      await storage.removeItem(STORE_KEY)
      return
    }
    await storage.setItem<DappConnection[]>(STORE_KEY, connections)
  }
}

export const dappConnections = new DappConnectionStore()
