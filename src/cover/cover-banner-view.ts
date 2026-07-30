import type { CoverDecision } from './ember-types.ts'

export type BannerTone = 'covered' | 'warning' | 'none' | 'unavailable'

export interface BannerView {
  label: string
  body: string
  tone: BannerTone
  showAck: boolean
  ackLabel: string | null
  approveLabel: string
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
      ? {
          label: 'Checking cover...',
          body: 'Ember is evaluating this exact approval. Nothing has been signed.',
          tone: 'none',
          showAck: false,
          ackLabel: null,
          approveLabel: 'Checking cover...',
        }
      : {
          label: '',
          body: '',
          tone: 'none',
          showAck: false,
          ackLabel: null,
          approveLabel: 'Approve and sign',
        }
  }
  switch (decision.coverStatus) {
    case 'covered':
      return decision.riskBand === 'high' || decision.riskBand === 'severe'
        ? {
            label: 'Covered, high risk',
            body: 'Cover is available, but review carefully.',
            tone: 'warning',
            showAck: true,
            ackLabel: 'I understand this is high risk.',
            approveLabel: 'Approve high-risk transaction',
          }
        : {
            label: 'Covered',
            body: 'Cover is available for this approval.',
            tone: 'covered',
            showAck: false,
            ackLabel: null,
            approveLabel: 'Approve and sign',
          }
    case 'unavailable':
      return {
        label: 'Cover unavailable',
        body: 'Ember cannot check this approval right now.',
        tone: 'unavailable',
        showAck: true,
        ackLabel: 'I understand cover is unavailable.',
        approveLabel: 'Sign without cover',
      }
    case 'unsupported':
      return {
        label: 'Not covered',
        body: 'This approval is outside Ember Cover.',
        tone: 'none',
        showAck: true,
        ackLabel: 'I understand I am signing without cover.',
        approveLabel: 'Sign without cover',
      }
    default:
      return {
        label: 'Not covered',
        body: 'Ember will not protect this approval.',
        tone: 'none',
        showAck: true,
        ackLabel: 'I understand I am signing without cover.',
        approveLabel: 'Sign without cover',
      }
  }
}
