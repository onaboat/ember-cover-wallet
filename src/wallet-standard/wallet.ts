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
  constructor() {
    this.#scheduleSilentRestore(0)
  }

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
          const accounts = await this.#connect(input)
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

  async #connect(input?: StandardConnectInput): Promise<WalletAccount[]> {
    const response = await sendMessage('connect', input)
    return response.accounts.map((account) => ({
      ...account,
      publicKey: decodeTransportBytes(account.publicKey),
    }))
  }

  #scheduleSilentRestore(attempt: number): void {
    const delays = [0, 250, 1000] as const
    const delay = delays[attempt]
    if (delay === undefined) {
      return
    }
    setTimeout(() => {
      void this.#restoreConnection().then((completed) => {
        if (!completed) {
          this.#scheduleSilentRestore(attempt + 1)
        }
      })
    }, delay)
  }

  async #restoreConnection(): Promise<boolean> {
    try {
      const accounts = await this.#connect({ silent: true })
      if (accounts.length > 0) {
        this.#accounts = accounts
        this.#emit('change', { accounts })
      }
      return true
    } catch {
      return false
    }
  }

  #emit<E extends StandardEventsNames>(event: E, ...args: Parameters<StandardEventsListeners[E]>): void {
    this.#listeners[event]?.forEach((listener) => {
      listener.apply(null, args)
    })
  }
}
