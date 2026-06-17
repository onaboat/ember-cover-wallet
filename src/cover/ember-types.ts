export type CoverStatus = 'covered' | 'not_covered' | 'unsupported' | 'unavailable'
export type RiskBand = 'low' | 'medium' | 'high' | 'severe'

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
  debug?: CoverDebugInfo
}

/** Only a `covered` decision is coverable; everything else is not. */
export function isCoverable(decision: Pick<CoverDecision, 'coverStatus'>): boolean {
  return decision.coverStatus === 'covered'
}
