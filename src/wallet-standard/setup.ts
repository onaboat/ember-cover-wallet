import { registerWallet } from '@wallet-standard/core'

import { EmberWallet } from './wallet.ts'

export function setup(): void {
  registerWallet(new EmberWallet())
}
