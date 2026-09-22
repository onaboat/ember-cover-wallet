import type { CoverStatusSnapshot } from './ember-types.ts'
import type { WalletLifecycleSnapshot } from '../background/ember-lifecycle-store.ts'

function microsToUsd(value: string): number {
  const micros = Number(value)
  return Number.isFinite(micros) && micros >= 0 ? micros / 1_000_000 : 0
}

/** Derive the account status from the same authoritative snapshot as its history. */
export function coverStatusFromLifecycle(
  snapshot: WalletLifecycleSnapshot | null,
): CoverStatusSnapshot | null {
  if (!snapshot || snapshot.authority !== 'server' || !snapshot.coverage) return null
  const coverage = snapshot.coverage
  const latestDecision = snapshot.decisions.at(-1)?.cachedDecision
  const allowance = snapshot.allowance
  if (!allowance) return null
  const remaining = allowance.available
  const used = allowance.committed
  return {
    subscriptionActive:
      coverage.status === 'active' && Date.now() < Date.parse(coverage.coverageEndsAt),
    subscriptionStatus: coverage.status,
    walletRegistered: true,
    tier: coverage.offerId,
    month: new Date().toISOString().slice(0, 7),
    currentPeriodEnd:
      coverage.currentBenefitPeriodEndsAt ?? coverage.coverageEndsAt,
    coveredTxPerMonth: coverage.coveredTransactionLimit,
    usedCoveredTxThisMonth: used,
    remainingCoveredTxThisMonth: remaining,
    monthlyLossCapUsd: microsToUsd(coverage.benefitPeriodLimitMicros),
    usedLossCapUsd: Math.max(
      0,
      microsToUsd(coverage.benefitPeriodLimitMicros) -
        microsToUsd(
          latestDecision?.remainingAggregateLimitMicros ??
            coverage.remainingBenefitPeriodLimitMicros ??
            coverage.benefitPeriodLimitMicros,
        ),
    ),
    remainingLossCapUsd: microsToUsd(
      latestDecision?.remainingAggregateLimitMicros ??
        coverage.remainingBenefitPeriodLimitMicros ??
        coverage.benefitPeriodLimitMicros,
    ),
  }
}
