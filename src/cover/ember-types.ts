export type CoverStatus = 'covered' | 'not_covered' | 'unsupported' | 'unavailable'
export type RiskBand = 'low' | 'medium' | 'high' | 'severe'

export interface CoverCapContext {
  monthlyLossCapUsd?: number
  remainingCoveredTxThisMonth: number
}

export interface CoverStatusSnapshot {
  subscriptionActive: boolean
  walletRegistered: boolean
  tier: string
  month: string
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
  reasonCodeCount?: number
  error?: string
}

/** Pre-sign cover decision, mirroring the Ember API response. */
export interface CoverDecision {
  requestId: string
  coverStatus: CoverStatus
  riskBand: RiskBand
  reasonCodes: string[]
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
  const coveredTxPerMonth = numberFrom(value['coveredTxPerMonth'])
  const usedCoveredTxThisMonth = numberFrom(value['usedCoveredTxThisMonth'])
  const remainingCoveredTxThisMonth = numberFrom(value['remainingCoveredTxThisMonth'])
  const monthlyLossCapUsd = numberFrom(value['monthlyLossCapUsd'])
  const usedLossCapUsd = numberFrom(value['usedLossCapUsd'])
  const remainingLossCapUsd = numberFrom(value['remainingLossCapUsd'])
  if (
    typeof value['subscriptionActive'] !== 'boolean' ||
    typeof value['walletRegistered'] !== 'boolean' ||
    typeof value['tier'] !== 'string' ||
    typeof value['month'] !== 'string' ||
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
    walletRegistered: value['walletRegistered'],
    tier: value['tier'],
    month: value['month'],
    coveredTxPerMonth,
    usedCoveredTxThisMonth,
    remainingCoveredTxThisMonth,
    monthlyLossCapUsd,
    usedLossCapUsd,
    remainingLossCapUsd,
  }
}

export function coverCapExhausted(decision: Pick<CoverDecision, 'reasonCodes' | 'coverStatus'>): boolean {
  return decision.coverStatus === 'not_covered' && decision.reasonCodes.includes('transaction_count_exhausted')
}

/** Only a `covered` decision is coverable; everything else is not. */
export function isCoverable(decision: Pick<CoverDecision, 'coverStatus'>): boolean {
  return decision.coverStatus === 'covered'
}
