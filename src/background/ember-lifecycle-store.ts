import type {
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
  coverage: CoverageInstanceResponse | null
  decisions: DecisionReference[]
  claims: WalletClaimResponse[]
  updatedAt: string
}

export interface WalletLifecycleSnapshot extends WalletLifecycleCache {
  authority: 'server' | 'cache' | 'unavailable'
  error: string | null
}

function emptyCache(walletAddress: string, now = new Date()): WalletLifecycleCache {
  return {
    version: 2,
    walletAddress,
    payment: null,
    coverage: null,
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
      decisions: [
        ...current.decisions.filter((reference) => reference.decisionId !== next.decisionId),
        next,
      ].slice(-MAX_DECISION_REFERENCES),
      updatedAt: this.now().toISOString(),
    })
  }

  async refresh(
    walletAddress: string,
    client: EmberWalletClient,
  ): Promise<WalletLifecycleSnapshot> {
    const cached = await this.load(walletAddress)
    try {
      const payment = cached.payment
        ? await client.getPayment(cached.payment.paymentId)
        : null
      const coverageId =
        payment?.coverageInstanceId ?? cached.coverage?.coverageInstanceId ?? null
      const coverage = coverageId
        ? await client.getCoverageInstance(coverageId)
        : null
      const decisions = await Promise.all(
        cached.decisions.map(async (reference) => ({
          ...reference,
          cachedDecision: await client.getDecision(reference.decisionId),
          cachedLineage: await client.getDecisionLineage(reference.decisionId),
        })),
      )
      const claimList: WalletClaimListResponse = await client.listClaims()
      const next: WalletLifecycleCache = {
        ...cached,
        payment,
        coverage,
        decisions,
        claims: claimList.claims,
        updatedAt: this.now().toISOString(),
      }
      await this.save(next)
      return { ...next, authority: 'server', error: null }
    } catch (error) {
      return {
        ...cached,
        authority:
          cached.payment || cached.coverage || cached.decisions.length > 0 || cached.claims.length > 0
            ? 'cache'
            : 'unavailable',
        error: error instanceof Error ? error.message : 'Ember lifecycle unavailable',
      }
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
