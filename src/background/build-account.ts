import { SOLANA_CHAINS } from '@solana/wallet-standard-chains'
import { SolanaSignMessage, SolanaSignTransaction } from '@solana/wallet-standard-features'
import type { WalletAccount } from '@wallet-standard/core'

import { base58Decode } from '../cover/ember-auth.ts'

/**
 * Builds the connected WalletAccount from the vault address. publicKey = base58Decode(address)
 * -> 32 raw Ed25519 bytes. `icon` is OMITTED (not undefined): exactOptionalPropertyTypes.
 */
export function buildConnectAccount(address: string): WalletAccount {
  return {
    address,
    publicKey: base58Decode(address),
    chains: SOLANA_CHAINS,
    features: [SolanaSignMessage, SolanaSignTransaction],
    label: 'Ember',
  }
}
