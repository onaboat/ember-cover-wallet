import { defineContentScript } from 'wxt/utils/define-content-script'

import { registerContentBridge } from '../messaging/content-bridge.ts'

export default defineContentScript({
  // Web pages only — not chrome:// or extension pages.
  // ISOLATED world: this bridge needs browser.runtime to relay page requests into the background.
  // The MAIN-world provider (inpage.content.ts) talks to it over shared-DOM CustomEvents.
  matches: ['http://*/*', 'https://*/*'],
  main() {
    registerContentBridge()
  },
})
