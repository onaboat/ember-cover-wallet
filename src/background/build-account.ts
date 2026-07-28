import { SolanaSignMessage, SolanaSignTransaction } from '@solana/wallet-standard-features'
import type { WalletAccount } from '@wallet-standard/core'

import { base58Decode } from '../crypto/base58.ts'
import { EMBER_SOLANA_CHAINS } from '../wallet-standard/chains.ts'

/**
 * Builds the connected WalletAccount from the vault address. publicKey = base58Decode(address)
 * -> 32 raw Ed25519 bytes. `icon` is OMITTED (not undefined): exactOptionalPropertyTypes.
 */
export function buildConnectAccount(address: string): WalletAccount {
  return {
    address,
    publicKey: base58Decode(address),
    chains: EMBER_SOLANA_CHAINS,
    features: [SolanaSignMessage, SolanaSignTransaction],
    label: 'Ember',
  }
}
