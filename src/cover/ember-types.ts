import type { PublicDecisionReason } from '@embercover/wallet-sdk'

export type CoverStatus = 'covered' | 'not_covered' | 'unsupported' | 'unavailable'
export type RiskBand = 'low' | 'medium' | 'high' | 'severe'

export interface CoverCapContext {
  monthlyLossCapUsd?: number
  remainingCoveredTxThisMonth: number
}

export interface CoverStatusSnapshot {
  subscriptionActive: boolean
  subscriptionStatus: string
  walletRegistered: boolean
  tier: string
  month: string
  currentPeriodEnd: string | null
  coveredTxPerMonth: number
  usedCoveredTxThisMonth: number
  remainingCoveredTxThisMonth: number
  monthlyLossCapUsd: number
  usedLossCapUsd: number
  remainingLossCapUsd: number
}

export interface CoverDebugInfo {
  stage:
    | 'no_wallet'
    | 'not_enrolled'
    | 'api_pre_sign_ok'
    | 'api_pre_sign_non_ok'
    | 'api_pre_sign_error'
    | 'provider_error'
    | 'cluster_mismatch'
    | 'approval_poll_timeout'
  apiAttempted: boolean
  proxyBaseUrl?: string
  dappUrl?: string
  walletAddress?: string
  enrolled?: boolean
  httpStatus?: number
  requestId?: string
  coverStatus?: CoverStatus
  riskBand?: RiskBand
  decisionExpiresAt?: string
  decisionReason?: PublicDecisionReason
  error?: string
}

/** Pre-sign cover decision, mirroring the Ember API response. */
export interface CoverDecision {
  requestId: string
  coverStatus: CoverStatus
  riskBand: RiskBand
  decisionReason: PublicDecisionReason
  /** RFC 3339; the decision is void after this instant (60s window). */
  decisionExpiresAt: string
  capContext?: CoverCapContext
  coveredTxCountImpact?: number
  debug?: CoverDebugInfo
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10)
  }
  return null
}

export function normalizeCoverCapContext(payload: unknown): CoverCapContext | null {
  const capContext = recordOf(recordOf(payload)['capContext'])
  const remaining = numberFrom(capContext['remainingCoveredTxThisMonth'])
  if (remaining === null) {
    return null
  }
  const monthlyLossCapUsd = numberFrom(capContext['monthlyLossCapUsd'])
  return {
    remainingCoveredTxThisMonth: remaining,
    ...(monthlyLossCapUsd === null ? {} : { monthlyLossCapUsd }),
  }
}

export function normalizeCoverStatusSnapshot(payload: unknown): CoverStatusSnapshot | null {
  const value = recordOf(payload)
  const currentPeriodEnd = value['currentPeriodEnd']
  const coveredTxPerMonth = numberFrom(value['coveredTxPerMonth'])
  const usedCoveredTxThisMonth = numberFrom(value['usedCoveredTxThisMonth'])
  const remainingCoveredTxThisMonth = numberFrom(value['remainingCoveredTxThisMonth'])
  const monthlyLossCapUsd = numberFrom(value['monthlyLossCapUsd'])
  const usedLossCapUsd = numberFrom(value['usedLossCapUsd'])
  const remainingLossCapUsd = numberFrom(value['remainingLossCapUsd'])
  if (
    typeof value['subscriptionActive'] !== 'boolean' ||
    typeof value['subscriptionStatus'] !== 'string' ||
    typeof value['walletRegistered'] !== 'boolean' ||
    typeof value['tier'] !== 'string' ||
    typeof value['month'] !== 'string' ||
    !(
      currentPeriodEnd === null ||
      (typeof currentPeriodEnd === 'string' && !Number.isNaN(Date.parse(currentPeriodEnd)))
    ) ||
    coveredTxPerMonth === null ||
    usedCoveredTxThisMonth === null ||
    remainingCoveredTxThisMonth === null ||
    monthlyLossCapUsd === null ||
    usedLossCapUsd === null ||
    remainingLossCapUsd === null
  ) {
    return null
  }
  return {
    subscriptionActive: value['subscriptionActive'],
    subscriptionStatus: value['subscriptionStatus'],
    walletRegistered: value['walletRegistered'],
    tier: value['tier'],
    month: value['month'],
    currentPeriodEnd,
    coveredTxPerMonth,
    usedCoveredTxThisMonth,
    remainingCoveredTxThisMonth,
    monthlyLossCapUsd,
    usedLossCapUsd,
    remainingLossCapUsd,
  }
}

export function coverPeriodExpired(snapshot: CoverStatusSnapshot, nowMs = Date.now()): boolean {
  if (snapshot.subscriptionStatus === 'expired') {
    return true
  }
  return snapshot.currentPeriodEnd !== null && Date.parse(snapshot.currentPeriodEnd) <= nowMs
}

export function coverStatusActive(snapshot: CoverStatusSnapshot, nowMs = Date.now()): boolean {
  return (
    snapshot.subscriptionActive &&
    snapshot.subscriptionStatus === 'active' &&
    snapshot.walletRegistered &&
    !coverPeriodExpired(snapshot, nowMs)
  )
}

export function coverCapExhausted(
  decision: Pick<CoverDecision, 'coverStatus' | 'decisionReason'>,
): boolean {
  return (
    decision.coverStatus === 'not_covered' &&
    decision.decisionReason === 'coverage_limit_reached'
  )
}

/** Only a `covered` decision is coverable; everything else is not. */
export function isCoverable(decision: Pick<CoverDecision, 'coverStatus'>): boolean {
  return decision.coverStatus === 'covered'
}
