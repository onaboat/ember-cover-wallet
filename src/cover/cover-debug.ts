/**
 * DEBUG ONLY. When true, the raw underwriting-engine response (incl. reasonCodes and the failure
 * reason for a fail-open) is logged to the service-worker console and surfaced in the approval
 * popup. MUST be false for any production build — it exposes engine internals.
 */
export const COVER_DEBUG = false

export function coverDebug(event: string, detail: unknown): void {
  if (COVER_DEBUG) {
    console.log('[cover-debug]', event, detail)
  }
}
