import type { CoverDecision } from './ember-types.ts'

export type BannerTone = 'covered' | 'warning' | 'none' | 'unavailable'

export interface BannerView {
  label: string
  tone: BannerTone
  showAck: boolean
}

/**
 * Maps a decision to user-facing banner copy. Deliberately uses ONLY
 * `coverStatus` + `riskBand` — never `reasonCodes` — so the public wallet never
 * reveals what the underwriting engine inspected.
 */
export function bannerView(
  decision: Pick<CoverDecision, 'coverStatus' | 'riskBand'> | null,
  isLoading: boolean,
): BannerView {
  if (!decision) {
    return isLoading
      ? { label: 'Checking cover…', tone: 'none', showAck: false }
      : { label: '', tone: 'none', showAck: false }
  }
  switch (decision.coverStatus) {
    case 'covered':
      return decision.riskBand === 'high' || decision.riskBand === 'severe'
        ? { label: 'Covered — high risk', tone: 'warning', showAck: true }
        : { label: 'Covered by Ember', tone: 'covered', showAck: false }
    case 'unavailable':
      return { label: 'Cover unavailable', tone: 'unavailable', showAck: false }
    default:
      // not_covered and unsupported both read as "Not covered" — opaque.
      return { label: 'Not covered', tone: 'none', showAck: false }
  }
}
