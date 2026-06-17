import { SOLANA_CHAINS } from '@solana/wallet-standard-chains'
import {
  SolanaSignMessage,
  type SolanaSignMessageFeature,
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features'
import {
  type IdentifierArray,
  StandardConnect,
  type StandardConnectFeature,
  type StandardConnectInput,
  type StandardConnectOutput,
  StandardDisconnect,
  type StandardDisconnectFeature,
  StandardEvents,
  type StandardEventsFeature,
  type StandardEventsListeners,
  type StandardEventsNames,
  type Wallet,
  type WalletAccount,
  type WalletIcon,
  type WalletVersion,
} from '@wallet-standard/core'

import { decodeTransportBytes } from '../messaging/transport-bytes.ts'
import { sendMessage } from '../messaging/window.ts'
import { signMessage } from './features/sign-message.ts'
import { signTransaction } from './features/sign-transaction.ts'
import { icon } from './icon.ts'

// EXACTLY the five features Ember implements. Closed intersection => tsc rejects extra/missing.
type EmberWalletFeatures = SolanaSignMessageFeature &
  SolanaSignTransactionFeature &
  StandardConnectFeature &
  StandardDisconnectFeature &
  StandardEventsFeature

export class EmberWallet implements Wallet {
  get accounts(): readonly WalletAccount[] {
    return this.#accounts
  }

  // "address valid on these clusters", NOT "can sign txs on them". signMessage is chain-agnostic.
  get chains(): IdentifierArray {
    return SOLANA_CHAINS
  }

  get features(): EmberWalletFeatures {
    return {
      [SolanaSignMessage]: {
        signMessage,
        version: this.version,
      },
      [SolanaSignTransaction]: {
        signTransaction,
        supportedTransactionVersions: ['legacy', 0],
        version: this.version,
      },
      [StandardConnect]: {
        connect: async (input?: StandardConnectInput): Promise<StandardConnectOutput> => {
          const response = await sendMessage('connect', input)
          const accounts: WalletAccount[] = response.accounts.map((account) => ({
            ...account,
            publicKey: decodeTransportBytes(account.publicKey),
          }))
          this.#accounts = accounts
          this.#emit('change', { accounts })
          return { accounts }
        },
        version: this.version,
      },
      [StandardDisconnect]: {
        disconnect: async (): Promise<void> => {
          await sendMessage('disconnect')
          this.#accounts = []
          this.#emit('change', { accounts: this.#accounts })
        },
        version: this.version,
      },
      [StandardEvents]: {
        on: <E extends StandardEventsNames>(event: E, listener: StandardEventsListeners[E]): (() => void) => {
          const existing: StandardEventsListeners[E][] = (this.#listeners[event] as StandardEventsListeners[E][] | undefined) ?? []
          existing.push(listener)
          this.#listeners[event] = existing
          return (): void => {
            this.#listeners[event] = this.#listeners[event]?.filter((l) => l !== listener) ?? []
          }
        },
        version: this.version,
      },
    }
  }

  get icon(): WalletIcon {
    return icon
  }

  get name(): string {
    return 'Ember'
  }

  get version(): WalletVersion {
    return '1.0.0'
  }

  #accounts: readonly WalletAccount[] = []
  #listeners: { [E in StandardEventsNames]?: StandardEventsListeners[E][] } = {}

  #emit<E extends StandardEventsNames>(event: E, ...args: Parameters<StandardEventsListeners[E]>): void {
    this.#listeners[event]?.forEach((listener) => {
      listener.apply(null, args)
    })
  }
}
