import type { CoverDecision } from './ember-types.ts'

export type BannerTone = 'covered' | 'warning' | 'none' | 'unavailable' | 'blocked'

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
 * `coverStatus` + `riskBand` — never `decisionReason` — so the approval action
 * is driven by protection state and risk, not backend policy detail. The one
 * exception is the signing disposition's `wallet_drain` safety verdict, which
 * names the danger so a skimming owner cannot miss it.
 */
export function bannerView(
  decision: (Pick<CoverDecision, 'coverStatus' | 'riskBand'> & Partial<Pick<CoverDecision, 'signingDisposition'>>) | null,
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
  const disposition = decision.signingDisposition
  if (disposition?.status === 'acknowledge' && disposition.reason === 'wallet_drain') {
    return {
      label: 'Looks like a wallet drain',
      body: 'This sends out a whole token balance, or nearly all your SOL, and nothing comes back. Ember will not cover it.',
      tone: 'blocked',
      showAck: true,
      ackLabel: 'I understand this may empty my wallet and is not covered.',
      approveLabel: 'Sign anyway without cover',
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
        label: 'Effects not understood',
        body: 'Ember could not sufficiently understand this approval. Cover does not apply.',
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
