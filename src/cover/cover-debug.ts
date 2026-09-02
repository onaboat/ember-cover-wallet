/**
 * DEBUG ONLY. When true, public decision metadata and the operational failure reason are logged
 * to the service-worker console and surfaced in the approval popup. MUST be false for any
 * production build.
 */
export const COVER_DEBUG = false

export function coverDebug(event: string, detail: unknown): void {
  if (COVER_DEBUG) {
    console.log('[cover-debug]', event, detail)
  }
}
