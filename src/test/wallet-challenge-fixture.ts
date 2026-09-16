import { createHash } from 'node:crypto'

import type { EmberWalletScope, WalletChallengeResponse } from '@embercover/wallet-sdk'

interface WalletChallengeFixtureInput {
  challengeId: string
  extensionOrigin: string
  integrationId: string
  integrationVersion: number
  issuedAt: Date
  nonce: string
  requestedScopes: readonly EmberWalletScope[]
  sessionPublicKey: string
  walletAddress: string
}

/** Builds the exact server challenge contract for wallet-owned test servers. */
export function walletChallengeFixture(
  input: WalletChallengeFixtureInput,
): WalletChallengeResponse {
  const expiresAt = new Date(input.issuedAt.getTime() + 5 * 60_000)
  const extensionId = input.extensionOrigin.slice('chrome-extension://'.length)
  const bindingHash = createHash('sha256').update(input.extensionOrigin).digest('hex')
  const resources = [
    `urn:ember:integration:${input.integrationId}:${input.integrationVersion}`,
    'urn:ember:environment:sandbox',
    `urn:ember:session-key:${input.sessionPublicKey}`,
    'urn:ember:client-kind:browser',
    `urn:ember:client-binding-sha256:${bindingHash}`,
    ...input.requestedScopes.map((scope) => `urn:ember:scope:${scope}`),
  ]
  const message = `${extensionId} wants you to sign in with your Solana account:\n${input.walletAddress}\n\nProve ownership of this wallet and authorize a short-lived Ember Cover session. This does not submit a transaction or move funds.\n\nURI: ${input.extensionOrigin}\nVersion: 1\nChain ID: devnet\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt.toISOString()}\nExpiration Time: ${expiresAt.toISOString()}\nRequest ID: ${input.challengeId}\nResources:\n- ${resources.join('\n- ')}`
  return {
    challengeId: input.challengeId,
    expiresAt: expiresAt.toISOString(),
    issuedAt: input.issuedAt.toISOString(),
    message,
    nonce: input.nonce,
  }
}
