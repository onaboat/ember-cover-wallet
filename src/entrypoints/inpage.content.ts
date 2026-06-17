import { defineContentScript } from 'wxt/utils/define-content-script'

import { setup } from '../wallet-standard/setup.ts'

// MAIN-world content script: registers the EmberWallet provider directly in the page realm at
// document_start — the way Phantom/modern wallets do it. This is robust where the old script-tag
// injection was fragile: it runs before the dapp's wallet-adapter enumerates wallets, and a strict
// CSP cannot block it (no <script src> is added to the page). The provider only uses CustomEvent
// messaging (window.ts), which crosses to the ISOLATED bridge over the shared DOM — no extension
// APIs are needed here.
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    setup()
  },
})
