import { expect, test } from 'vitest'

import { signingPolicyMessage } from './signing-policy.ts'

test('a wallet drain warning tells the owner it looks like it empties the wallet', () => {
  expect(signingPolicyMessage({ status: 'acknowledge', reason: 'wallet_drain' })).toMatch(/empt(y|ies) your wallet/i)
})

test('a wallet drain warning tells the owner it is not covered', () => {
  expect(signingPolicyMessage({ status: 'acknowledge', reason: 'wallet_drain' })).toMatch(/not covered/i)
})
