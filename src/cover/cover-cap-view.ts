import type { CoverCapContext, CoverStatus, CoverStatusSnapshot } from './ember-types.ts'

function checkLabel(count: number): string {
  return count === 1 ? 'Ember Cover check' : 'Ember Cover checks'
}

export function formatCoverCapContext(capContext: CoverCapContext): string {
  const remaining = capContext.remainingCoveredTxThisMonth
  return `${remaining} ${checkLabel(remaining)} left in this coverage period`
}

export function formatCoverStatusSnapshot(snapshot: CoverStatusSnapshot): string {
  return `${snapshot.remainingCoveredTxThisMonth} of ${snapshot.coveredTxPerMonth} ${checkLabel(snapshot.coveredTxPerMonth)} left in this coverage period`
}

export function formatLossCapSnapshot(snapshot: CoverStatusSnapshot): string {
  return `$${snapshot.remainingLossCapUsd.toLocaleString()} of $${snapshot.monthlyLossCapUsd.toLocaleString()} coverage limit left`
}

export function coverCapReviewText(status: CoverStatus, capContext: CoverCapContext, impact = 0): string {
  if (status === 'not_covered' && impact === 0 && capContext.remainingCoveredTxThisMonth === 0) {
    return 'No Ember Cover checks left in this coverage period.'
  }
  if (impact > 0) {
    return `Uses ${impact} ${checkLabel(impact)}. ${formatCoverCapContext(capContext)}.`
  }
  return formatCoverCapContext(capContext)
}
