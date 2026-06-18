import type { Runtime } from 'webextension-polyfill'

import { onMessage } from '../messaging/extension.ts'
import { connect, disconnect, signMessage, signTransaction } from './actions.ts'

/**
 * Runtime.MessageSender has no portable typed `origin` (Chrome-MV3-only). Derive from sender.url;
 * read Chrome's `origin` opportunistically via cast, then parse sender.url.
 */
export function originOf(sender: Runtime.MessageSender): string | undefined {
  const chromeOrigin = (sender as Runtime.MessageSender & { origin?: string }).origin
  if (chromeOrigin) {
    return chromeOrigin
  }
  if (sender.url) {
    try {
      return new URL(sender.url).origin
    } catch {
      return undefined
    }
  }
  return undefined
}

export function registerMessageHandlers(): void {
  onMessage('connect', async ({ data, sender }) => await connect(data, originOf(sender)))
  onMessage('disconnect', async ({ sender }) => await disconnect(originOf(sender)))
  onMessage('signMessage', async ({ data, sender }) => await signMessage(data, originOf(sender)))
  onMessage('signTransaction', async ({ data, sender }) => await signTransaction(data, originOf(sender)))
}
