import { registerWallet } from '@wallet-standard/core'

import { EmberWallet } from './wallet.ts'

const REGISTERED_KEY = Symbol.for('ember.wallet-standard.registered')

export function setup(): void {
  const registry = globalThis as Record<PropertyKey, unknown>
  if (registry[REGISTERED_KEY] === true) {
    return
  }
  registry[REGISTERED_KEY] = true
  try {
    registerWallet(new EmberWallet())
  } catch (error) {
    delete registry[REGISTERED_KEY]
    throw error
  }
}
