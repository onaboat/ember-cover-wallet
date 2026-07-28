import { defineBackground } from 'wxt/utils/define-background'

import { EmberCoverProvider, registerCoverService } from '../background/cover-service.ts'
import {
  CoveragePaymentProvider,
  registerCoveragePaymentService,
} from '../background/coverage-payment-service.ts'
import { registerEvidenceOutboxRecovery } from '../background/evidence-outbox.ts'
import { registerMessageHandlers } from '../background/message-handlers.ts'
import { registerRequestService } from '../background/request-service.ts'
import { registerWalletTransferService, WalletTransferProvider } from '../background/sol-transfer-service.ts'
import { registerVaultService } from '../background/vault-service.ts'
import {
  registerActivityReconciliation,
  registerWalletDataService,
} from '../background/wallet-data-service.ts'

export default defineBackground(() => {
  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    console.error('[ember] unhandled rejection', event.reason)
  })
  const controller = registerVaultService()
  const cover = new EmberCoverProvider(controller)
  registerCoverService(cover)
  registerEvidenceOutboxRecovery(() => cover.activeClient())
  const walletData = registerWalletDataService()
  registerActivityReconciliation(walletData, controller)
  registerWalletTransferService(new WalletTransferProvider(controller, cover))
  registerCoveragePaymentService(new CoveragePaymentProvider(controller, cover))
  registerRequestService(controller, cover)
  registerMessageHandlers()
})
