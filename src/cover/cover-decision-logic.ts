import type { CoverDecision } from './ember-types.ts'

/**
 * A decision is stale once `now` passes its expiry (the API's 60s window). The
 * hook re-fetches before a stale decision could be bound at sign time.
 */
export function isExpired(decision: Pick<CoverDecision, 'decisionExpiresAt'>, nowMs: number): boolean {
  return nowMs >= Date.parse(decision.decisionExpiresAt)
}
