import { sendMessage } from './extension.ts'
import { onMessage } from './window.ts'

/**
 * Relays page-realm requests into the background. ZERO-MARGIN INVARIANT: each handler MUST
 * `return await sendMessage(...)` — @webext-core ships the returned value back to the page as
 * the RPC response. Dropping the return makes the dapp promise hang forever.
 */
export function registerContentBridge(): void {
  onMessage('connect', async ({ data }) => await sendMessage('connect', data))
  onMessage('disconnect', async () => await sendMessage('disconnect'))
  onMessage('signMessage', async ({ data }) => await sendMessage('signMessage', data))
  onMessage('signTransaction', async ({ data }) => await sendMessage('signTransaction', data))
}
