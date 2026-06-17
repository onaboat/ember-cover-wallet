import { defineBackground } from 'wxt/utils/define-background'

import { EmberCoverProvider, registerCoverService } from '../background/cover-service.ts'
import { registerMessageHandlers } from '../background/message-handlers.ts'
import { registerRequestService } from '../background/request-service.ts'
import { registerVaultService } from '../background/vault-service.ts'

export default defineBackground(() => {
  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    console.error('[ember] unhandled rejection', event.reason)
  })
  const controller = registerVaultService()
  const cover = new EmberCoverProvider(controller)
  registerCoverService(cover)
  registerRequestService(controller, cover)
  registerMessageHandlers()
})
