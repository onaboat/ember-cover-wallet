import { SolanaSignMessage, SolanaSignTransaction } from '@solana/wallet-standard-features'
import { StandardConnect, StandardDisconnect, StandardEvents } from '@wallet-standard/core'
import { expect, test } from 'vitest'

import { EmberWallet } from './wallet.ts'

test('advertises exactly the five implemented features', () => {
  expect(Object.keys(new EmberWallet().features).sort()).toEqual(
    [SolanaSignMessage, SolanaSignTransaction, StandardConnect, StandardDisconnect, StandardEvents].sort(),
  )
})
