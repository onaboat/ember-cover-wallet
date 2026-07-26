import { afterEach, expect, test, vi } from 'vitest'

vi.mock('@wallet-standard/core', () => ({ registerWallet: vi.fn() }))

import { registerWallet } from '@wallet-standard/core'
import { setup } from './setup.ts'

const REGISTERED_KEY = Symbol.for('ember.wallet-standard.registered')

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[REGISTERED_KEY]
  vi.clearAllMocks()
})

test('registers Ember only once when the content script setup runs twice', () => {
  setup()
  setup()

  expect(vi.mocked(registerWallet)).toHaveBeenCalledOnce()
})
