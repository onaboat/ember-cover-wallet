export type CoverStatus = 'covered' | 'not_covered' | 'unsupported' | 'unavailable'
export type RiskBand = 'low' | 'medium' | 'high' | 'severe'

/** Pre-sign cover decision, mirroring the Ember API response. */
export interface CoverDecision {
  requestId: string
  coverStatus: CoverStatus
  riskBand: RiskBand
  reasonCodes: string[]
  /** RFC 3339; the decision is void after this instant (60s window). */
  decisionExpiresAt: string
}

/** Only a `covered` decision is coverable; everything else is not. */
export function isCoverable(decision: Pick<CoverDecision, 'coverStatus'>): boolean {
  return decision.coverStatus === 'covered'
}
