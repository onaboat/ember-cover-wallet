import type {
  AllowanceSnapshot,
  CoverageDecisionResponse,
  CoverageInstanceResponse,
  DecisionLineageResponse,
  EmberWalletClient,
  PaymentResponse,
  WalletClaimListResponse,
  WalletClaimResponse,
} from '@embercover/wallet-sdk'
import { storage } from 'wxt/utils/storage'

const LEGACY_STORE_KEY = 'local:ember-authoritative-lifecycle-cache:v1' as const
const STORE_KEY = 'local:ember-authoritative-lifecycle-cache:v2' as const
const MAX_DECISION_REFERENCES = 50

export interface DecisionReference {
  cachedDecision: CoverageDecisionResponse
  cachedLineage: DecisionLineageResponse | null
  createdAt: string
  decisionId: string
  dappOrigin: string | null
  signature: string | null
}

export interface WalletLifecycleCache {
  version: 2
  walletAddress: string
  payment: PaymentResponse | null
  allowance?: AllowanceSnapshot | null
  coverage: CoverageInstanceResponse | null
  decisions: DecisionReference[]
  claims: WalletClaimResponse[]
  updatedAt: string
}

export interface WalletLifecycleSnapshot extends WalletLifecycleCache {
  authority: 'server' | 'cache' | 'unavailable'
  error: string | null
  historyError?: string | null
}

export interface WalletCoverageSnapshot {
  authority: 'server' | 'cache' | 'unavailable'
  allowance?: AllowanceSnapshot | null
  coverage: CoverageInstanceResponse | null
  error: string | null
  payment: PaymentResponse | null
  updatedAt: string
  walletAddress: string
}

function emptyCache(walletAddress: string, now = new Date()): WalletLifecycleCache {
  return {
    version: 2,
    walletAddress,
    payment: null,
    coverage: null,
    allowance: null,
    decisions: [],
    claims: [],
    updatedAt: now.toISOString(),
  }
}

function normalizeCache(value: unknown, walletAddress: string): WalletLifecycleCache {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as Partial<WalletLifecycleCache>).version !== 2 ||
    (value as Partial<WalletLifecycleCache>).walletAddress !== walletAddress
  ) {
    return emptyCache(walletAddress)
  }
  const stored = value as WalletLifecycleCache
  return {
    ...emptyCache(walletAddress),
    ...stored,
    decisions: Array.isArray(stored.decisions) ? stored.decisions.slice(-MAX_DECISION_REFERENCES) : [],
    claims: Array.isArray(stored.claims) ? stored.claims : [],
  }
}

export class EmberLifecycleStore {
  private readonly now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.now = now
  }

  async load(walletAddress: string): Promise<WalletLifecycleCache> {
    const value = await storage.getItem<unknown>(STORE_KEY)
    await storage.removeItem(LEGACY_STORE_KEY)
    return normalizeCache(value, walletAddress)
  }

  async recordPayment(
    walletAddress: string,
    payment: PaymentResponse,
    coverage: CoverageInstanceResponse | null,
  ): Promise<void> {
    const current = await this.load(walletAddress)
    await this.save({
      ...current,
      payment,
      coverage: coverage ?? current.coverage,
      updatedAt: this.now().toISOString(),
    })
  }

  async recordDecision(input: {
    walletAddress: string
    decision: CoverageDecisionResponse
    dappOrigin?: string
    signature?: string
  }): Promise<void> {
    const current = await this.load(input.walletAddress)
    const existing = current.decisions.find(
      (reference) => reference.decisionId === input.decision.decisionId,
    )
    const next: DecisionReference = {
      cachedDecision: input.decision,
      cachedLineage: existing?.cachedLineage ?? null,
      createdAt: existing?.createdAt ?? this.now().toISOString(),
      decisionId: input.decision.decisionId,
      dappOrigin: input.dappOrigin ?? existing?.dappOrigin ?? null,
      signature: input.signature ?? existing?.signature ?? null,
    }
    await this.save({
      ...current,
      allowance: input.decision.allowance,
      decisions: [
        ...current.decisions.filter((reference) => reference.decisionId !== next.decisionId),
        next,
      ].slice(-MAX_DECISION_REFERENCES),
      updatedAt: this.now().toISOString(),
    })
  }

  /** Current coverage is server authority; historical IDs are display references. */
  async resolveCoverageForDecision(
    walletAddress: string,
    client: EmberWalletClient,
  ): Promise<WalletCoverageSnapshot> {
    return await this.refreshCoverage(walletAddress, client)
  }

  async refreshCoverage(
    walletAddress: string,
    client: EmberWalletClient,
    current?: WalletLifecycleCache,
  ): Promise<WalletCoverageSnapshot> {
    const cached = current ?? await this.load(walletAddress)
    try {
      const payment = cached.payment
      const currentCoverage = await client.getCurrentCoverage()
      const coverage = currentCoverage.status === 'active' ? currentCoverage.coverage : null
      const allowance = currentCoverage.status === 'active' ? currentCoverage.allowance : null
      const updatedAt = this.now().toISOString()
      await this.save({
        ...cached,
        payment,
        coverage,
        allowance,
        updatedAt,
      })
      return {
        authority: 'server',
        coverage,
        allowance,
        error: null,
        payment,
        updatedAt,
        walletAddress,
      }
    } catch (error) {
      return {
        authority: cached.payment || cached.coverage ? 'cache' : 'unavailable',
        coverage: cached.coverage,
        error: error instanceof Error ? error.message : 'Ember coverage unavailable',
        payment: cached.payment,
        updatedAt: cached.updatedAt,
        walletAddress,
      }
    }
  }

  async refresh(
    walletAddress: string,
    client: EmberWalletClient,
  ): Promise<WalletLifecycleSnapshot> {
    const cached = await this.load(walletAddress)
    // Save current coverage before history: missing records must never suppress
    // the live authority or allowance from the current-coverage endpoint.
    const current = await this.refreshCoverage(walletAddress, client, cached)
    const historyErrors: string[] = []
    async function history<T>(read: () => Promise<T>, fallback: T): Promise<T> {
      try { return await read() } catch (error) {
        historyErrors.push(error instanceof Error ? error.message : 'History unavailable')
        return fallback
      }
    }
    const [payment, decisions, claimList] = await Promise.all([
      cached.payment ? history(() => client.getPayment(cached.payment!.paymentId), cached.payment) : null,
      Promise.all(cached.decisions.map(async (reference) => ({
        ...reference,
        cachedDecision: await history(() => client.getDecision(reference.decisionId), reference.cachedDecision),
        cachedLineage: await history(() => client.getDecisionLineage(reference.decisionId), reference.cachedLineage),
      }))),
      history<WalletClaimListResponse>(() => client.listClaims(), { claims: cached.claims }),
    ])
    const next: WalletLifecycleCache = {
      ...cached,
      payment,
      coverage: current.coverage,
      allowance: current.authority === 'server' ? current.allowance ?? null : cached.allowance ?? null,
      decisions,
      claims: claimList.claims,
      updatedAt: current.updatedAt,
    }
    await this.save(next)
    return {
      ...next,
      authority: current.authority,
      error: current.error,
      historyError: historyErrors.length ? 'Some history could not be refreshed. Saved records are shown.' : null,
    }
  }

  async clear(): Promise<void> {
    await storage.removeItem(STORE_KEY)
  }

  private async save(value: WalletLifecycleCache): Promise<void> {
    await storage.setItem(STORE_KEY, value)
  }
}

export const emberLifecycleStore = new EmberLifecycleStore()
