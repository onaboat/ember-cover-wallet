/** Product signing policy; independent of SDK, UI, storage and RPC. */
export type SigningDisposition =
  | { status: 'allow' }
  | { status: 'acknowledge'; reason: 'high_risk' | 'without_coverage' | 'unsupported_effects' | 'assessment_unavailable' | 'wallet_drain' }
  | { status: 'block'; reason: 'unlimited_token_access' | 'authority_handover' | 'native_token_redirection' }

export type SigningAcknowledgement = 'coverage' | 'effects' | 'message' | 'safety'

export interface SigningReviewView {
  reviewId: string
  expiresAt?: string
  disposition: SigningDisposition
  requiredAcknowledgements: SigningAcknowledgement[]
}

export interface SigningConsent {
  reviewId: string
  acknowledged: readonly SigningAcknowledgement[]
}

export function signingDisposition(value: SigningDisposition | null | undefined): SigningDisposition {
  return value ?? { status: 'acknowledge', reason: 'assessment_unavailable' }
}

export function signingPolicyMessage(disposition: SigningDisposition): string {
  if (disposition.status === 'allow') return 'No blocking effects were identified in this assessment.'
  switch (disposition.reason) {
    case 'unlimited_token_access': return 'Signing blocked: this transaction grants unlimited token access.'
    case 'authority_handover': return 'Signing blocked: this transaction hands over control of a token account.'
    case 'native_token_redirection': return 'Signing blocked: this transaction redirects a wrapped SOL account balance away from its owner.'
    case 'high_risk': return 'This approval has identified risks. Review them before signing.'
    case 'without_coverage': return 'You are signing without cover.'
    case 'unsupported_effects': return 'The transaction effects could not be sufficiently understood.'
    case 'assessment_unavailable': return 'A safety assessment is unavailable. The wallet cannot establish whether this request has dangerous effects.'
    case 'wallet_drain': return 'This transaction looks like it empties your wallet: it sends out a whole token balance, or nearly all your SOL, and nothing comes back. It is not covered. Only continue if you are sure.'
  }
}

export function assertSigningConsent(review: SigningReviewView, consent: SigningConsent | undefined): void {
  if (review.disposition.status === 'block') throw new Error(signingPolicyMessage(review.disposition))
  if (!consent || consent.reviewId !== review.reviewId) throw new Error('Signing review changed. Review this request again.')
  if (!Array.isArray(consent.acknowledged) || review.requiredAcknowledgements.some(reason => !consent.acknowledged.includes(reason))) {
    throw new Error('Required signing acknowledgements are missing')
  }
}
