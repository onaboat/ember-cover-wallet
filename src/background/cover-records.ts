import { storage } from 'wxt/utils/storage'

import type { CoverStatus } from '../cover/ember-types.ts'
import type { WalletCoverStatus } from './wallet-data-service.ts'
import type { WalletCluster } from './wallet-data-config.ts'

/** Fold a cover decision status into the narrower activity status (unsupported -> not_covered). */
export function toWalletCoverStatus(status: CoverStatus): WalletCoverStatus {
  return status === 'unsupported' ? 'not_covered' : status
}

const STORE_KEY = 'local:ember-cover-records' as const
/** Bound storage growth: keep the 50 most recent records GLOBALLY (across addresses).
 * Sufficient for the single-address vault; list() filters by wallet at read time. */
const MAX_COVER_RECORDS = 50

/**
 * A locally-persisted cover verdict for one signed transaction, keyed by the
 * base58 on-chain signature so the Activity feed can match it to the on-chain
 * row (see wallet-data-service getSnapshot + App.tsx renderActivity).
 */
export interface CoverRecord {
  signature: string
  walletAddress: string
  coverStatus: WalletCoverStatus
  riskBand: string | null
  requestId: string | null
  dappOrigin: string | null
  recordedAt: string
  title: string | null
  actionKind: string | null
  amount: string | null
  tokenSymbol: string | null
  tokenMint: string | null
  recipient: string | null
  source: string | null
  feePayer: string | null
  programs: string[]
  cluster: WalletCluster | null
  transactionStatus: WalletTransactionStatus
  lastCheckedAt: string | null
  failureReason: string | null
  blockhash: string | null
  lastValidBlockHeight: string | null
  broadcastOwner: 'wallet' | 'dapp' | null
  signedTransactionBase64: string | null
}

export type WalletTransactionStatus =
  | 'signed'
  | 'broadcast'
  | 'processed'
  | 'confirmed'
  | 'finalized'
  | 'failed'
  | 'expired'
  | 'unknown'

export interface CoverRecordInput {
  signature: string
  walletAddress: string
  coverStatus: WalletCoverStatus
  riskBand?: string | null
  requestId?: string | null
  dappOrigin?: string | null
  title?: string | null
  actionKind?: string | null
  amount?: string | null
  tokenSymbol?: string | null
  tokenMint?: string | null
  recipient?: string | null
  source?: string | null
  feePayer?: string | null
  programs?: string[]
  cluster?: WalletCluster | null
  transactionStatus?: WalletTransactionStatus
  failureReason?: string | null
  blockhash?: string | null
  lastValidBlockHeight?: string | null
  broadcastOwner?: 'wallet' | 'dapp' | null
  signedTransactionBase64?: string | null
}

export interface CoverRecordStateUpdate {
  signature: string
  walletAddress: string
  transactionStatus: WalletTransactionStatus
  failureReason?: string | null
}

interface CoverRecordStoreDeps {
  now?: () => Date
}

function normalizeCoverRecord(value: unknown): CoverRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (!(
    typeof record.signature === 'string' &&
    typeof record.walletAddress === 'string' &&
    typeof record.coverStatus === 'string' &&
    typeof record.recordedAt === 'string'
  )) {
    return null
  }
  return {
    signature: record.signature,
    walletAddress: record.walletAddress,
    coverStatus: record.coverStatus as WalletCoverStatus,
    riskBand: typeof record.riskBand === 'string' ? record.riskBand : null,
    requestId: typeof record.requestId === 'string' ? record.requestId : null,
    dappOrigin: typeof record.dappOrigin === 'string' ? record.dappOrigin : null,
    recordedAt: record.recordedAt,
    title: typeof record.title === 'string' ? record.title : null,
    actionKind: typeof record.actionKind === 'string' ? record.actionKind : null,
    amount: typeof record.amount === 'string' ? record.amount : null,
    tokenSymbol: typeof record.tokenSymbol === 'string' ? record.tokenSymbol : null,
    tokenMint: typeof record.tokenMint === 'string' ? record.tokenMint : null,
    recipient: typeof record.recipient === 'string' ? record.recipient : null,
    source: typeof record.source === 'string' ? record.source : null,
    feePayer: typeof record.feePayer === 'string' ? record.feePayer : null,
    programs: Array.isArray(record.programs)
      ? record.programs.filter((program): program is string => typeof program === 'string')
      : [],
    cluster:
      record.cluster === 'devnet' || record.cluster === 'mainnet-beta'
        ? record.cluster
        : null,
    transactionStatus:
      typeof record.transactionStatus === 'string'
        ? (record.transactionStatus as WalletTransactionStatus)
        : 'signed',
    lastCheckedAt: typeof record.lastCheckedAt === 'string' ? record.lastCheckedAt : null,
    failureReason: typeof record.failureReason === 'string' ? record.failureReason : null,
    blockhash: typeof record.blockhash === 'string' ? record.blockhash : null,
    lastValidBlockHeight:
      typeof record.lastValidBlockHeight === 'string' ? record.lastValidBlockHeight : null,
    broadcastOwner:
      record.broadcastOwner === 'wallet' || record.broadcastOwner === 'dapp'
        ? record.broadcastOwner
        : null,
    signedTransactionBase64:
      typeof record.signedTransactionBase64 === 'string' ? record.signedTransactionBase64 : null,
  }
}

export class CoverRecordStore {
  #now: () => Date

  constructor(deps: CoverRecordStoreDeps = {}) {
    this.#now = deps.now ?? (() => new Date())
  }

  /** Persist (or update) the cover verdict for a signed transaction. Upserts by signature. */
  async record(input: CoverRecordInput): Promise<CoverRecord> {
    const records = await this.#read()
    const existing = records.find((record) => record.signature === input.signature)
    const next: CoverRecord = {
      signature: input.signature,
      walletAddress: input.walletAddress,
      coverStatus: input.coverStatus,
      riskBand: input.riskBand ?? null,
      requestId: input.requestId ?? null,
      dappOrigin: input.dappOrigin ?? null,
      recordedAt: existing?.recordedAt ?? this.#now().toISOString(),
      title: input.title ?? null,
      actionKind: input.actionKind ?? null,
      amount: input.amount ?? null,
      tokenSymbol: input.tokenSymbol ?? null,
      tokenMint: input.tokenMint ?? null,
      recipient: input.recipient ?? null,
      source: input.source ?? null,
      feePayer: input.feePayer ?? null,
      programs: input.programs ?? [],
      cluster: input.cluster ?? existing?.cluster ?? null,
      transactionStatus: input.transactionStatus ?? existing?.transactionStatus ?? 'signed',
      lastCheckedAt: existing?.lastCheckedAt ?? null,
      failureReason: input.failureReason ?? existing?.failureReason ?? null,
      blockhash: input.blockhash ?? existing?.blockhash ?? null,
      lastValidBlockHeight:
        input.lastValidBlockHeight ?? existing?.lastValidBlockHeight ?? null,
      broadcastOwner: input.broadcastOwner ?? existing?.broadcastOwner ?? null,
      signedTransactionBase64:
        input.signedTransactionBase64 ?? existing?.signedTransactionBase64 ?? null,
    }
    await this.#write([...records.filter((record) => record.signature !== input.signature), next])
    return next
  }

  /** Cover records for one wallet, used to populate the Activity snapshot. */
  async list(walletAddress: string, cluster?: WalletCluster): Promise<CoverRecord[]> {
    const records = await this.#read()
    return records.filter(
      (record) =>
        record.walletAddress === walletAddress &&
        (cluster === undefined ||
          record.cluster === cluster ||
          (record.cluster === null && cluster === 'devnet')),
    )
  }

  async updateTransactionStates(updates: readonly CoverRecordStateUpdate[]): Promise<void> {
    if (updates.length === 0) {
      return
    }
    const records = await this.#read()
    const checkedAt = this.#now().toISOString()
    const updateByKey = new Map(
      updates.map((update) => [`${update.walletAddress}:${update.signature}`, update]),
    )
    let changed = false
    const next = records.map((record) => {
      const update = updateByKey.get(`${record.walletAddress}:${record.signature}`)
      if (!update) {
        return record
      }
      changed = true
      return {
        ...record,
        transactionStatus: update.transactionStatus,
        lastCheckedAt: checkedAt,
        failureReason: update.failureReason ?? null,
      } satisfies CoverRecord
    })
    if (changed) {
      await this.#write(next)
    }
  }

  async clear(): Promise<void> {
    await storage.removeItem(STORE_KEY)
  }

  async #read(): Promise<CoverRecord[]> {
    const stored = await storage.getItem<unknown>(STORE_KEY)
    return Array.isArray(stored)
      ? stored.map(normalizeCoverRecord).filter((record): record is CoverRecord => record !== null)
      : []
  }

  async #write(records: CoverRecord[]): Promise<void> {
    if (records.length === 0) {
      await storage.removeItem(STORE_KEY)
      return
    }
    await storage.setItem<CoverRecord[]>(STORE_KEY, records.slice(-MAX_COVER_RECORDS))
  }
}

export const coverRecords = new CoverRecordStore()
