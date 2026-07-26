import { storage } from 'wxt/utils/storage'

import type { CoverStatus } from '../cover/ember-types.ts'
import type { WalletCoverStatus } from './wallet-data-service.ts'

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
}

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
}

interface CoverRecordStoreDeps {
  now?: () => Date
}

function isCoverRecord(value: unknown): value is CoverRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.signature === 'string' &&
    typeof record.walletAddress === 'string' &&
    typeof record.coverStatus === 'string' &&
    typeof record.recordedAt === 'string'
  )
}

export class CoverRecordStore {
  #now: () => Date

  constructor(deps: CoverRecordStoreDeps = {}) {
    this.#now = deps.now ?? (() => new Date())
  }

  /** Persist (or update) the cover verdict for a signed transaction. Upserts by signature. */
  async record(input: CoverRecordInput): Promise<CoverRecord> {
    const records = await this.#read()
    const next: CoverRecord = {
      signature: input.signature,
      walletAddress: input.walletAddress,
      coverStatus: input.coverStatus,
      riskBand: input.riskBand ?? null,
      requestId: input.requestId ?? null,
      dappOrigin: input.dappOrigin ?? null,
      recordedAt: this.#now().toISOString(),
      title: input.title ?? null,
      actionKind: input.actionKind ?? null,
      amount: input.amount ?? null,
      tokenSymbol: input.tokenSymbol ?? null,
      tokenMint: input.tokenMint ?? null,
      recipient: input.recipient ?? null,
      source: input.source ?? null,
      feePayer: input.feePayer ?? null,
      programs: input.programs ?? [],
    }
    await this.#write([...records.filter((record) => record.signature !== input.signature), next])
    return next
  }

  /** Cover records for one wallet, used to populate the Activity snapshot. */
  async list(walletAddress: string): Promise<CoverRecord[]> {
    const records = await this.#read()
    return records.filter((record) => record.walletAddress === walletAddress)
  }

  async #read(): Promise<CoverRecord[]> {
    const stored = await storage.getItem<unknown>(STORE_KEY)
    return Array.isArray(stored) ? stored.filter(isCoverRecord) : []
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
