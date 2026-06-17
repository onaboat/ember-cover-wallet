import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { storage } from 'wxt/utils/storage'

import { EmberClient } from '../cover/ember-client.ts'
import type { CoverDecision } from '../cover/ember-types.ts'
import { sessionAuthorizationPayload } from '../cover/session-auth.ts'

import { COVER_CONFIG } from './cover-config.ts'
import { getSessionPublicKey, signWithSession } from './session-key.ts'

export interface PreSignArgs {
  transactionBytes: string
  dappUrl?: string
}

export interface PostSignArgs {
  requestId: string
  signedBytes: string
  signature?: string
  signingWalletPublicKey: string
  walletTimestamp: string
}

export interface CoverProvider {
  preSign(args: PreSignArgs): Promise<CoverDecision>
  postSign(args: PostSignArgs): Promise<void>
  enroll(): Promise<boolean>
  isEnrolled(): Promise<boolean>
}

/** The SW-side VAULT signer the cover provider needs for one-time enrollment. */
export interface CoverWalletSigner {
  getAddress(): Promise<string | null>
  sign(message: Uint8Array): Promise<Uint8Array>
}

interface Enrollment {
  sessionPublicKey: string
  /** base64 of the wallet's signature over sessionAuthorizationPayload(session, wallet). */
  walletAuthSig: string
  walletAddress: string
}

const ENROLL_KEY = 'local:ember-cover-enrollment' as const
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))

function unavailable(): CoverDecision {
  return {
    requestId: '',
    coverStatus: 'unavailable',
    riskBand: 'severe',
    reasonCodes: [],
    decisionExpiresAt: new Date(0).toISOString(),
  }
}

/**
 * Two-sig cover provider. Cover requests are signed by the SESSION key (silent, no unlock) and
 * carry the wallet's one-time authorization; walletPublicKey is the VAULT address (the tx signer).
 * The vault key is used ONLY at enroll() (authorize the session key + register), one unlock.
 */
export class EmberCoverProvider implements CoverProvider {
  #signer: CoverWalletSigner
  #client: EmberClient

  constructor(signer: CoverWalletSigner, deps: { fetch?: typeof fetch } = {}) {
    this.#signer = signer
    this.#client = new EmberClient(COVER_CONFIG, signWithSession, {
      ...deps,
      sessionAuthHeader: () => this.#sessionHeader(),
    })
  }

  async #sessionHeader(): Promise<string | undefined> {
    const e = await storage.getItem<Enrollment>(ENROLL_KEY)
    return e ? `${e.sessionPublicKey}.${e.walletAuthSig}` : undefined
  }

  async isEnrolled(): Promise<boolean> {
    return (await storage.getItem<Enrollment>(ENROLL_KEY)) !== null
  }

  /** One-time: vault authorizes the session key + registers the vault address. Needs unlock. */
  async enroll(): Promise<boolean> {
    const walletAddress = await this.#signer.getAddress()
    if (!walletAddress) {
      return false
    }
    const sessionPublicKey = await getSessionPublicKey()
    const walletAuthSig = await this.#signer.sign(sessionAuthorizationPayload(sessionPublicKey, walletAddress))
    await storage.setItem<Enrollment>(ENROLL_KEY, {
      sessionPublicKey,
      walletAuthSig: b64(walletAuthSig),
      walletAddress,
    })
    // Register the vault address; the NONCE is signed by the vault key (proves control of it).
    return this.#client.register(walletAddress, (m) => this.#signer.sign(m))
  }

  async preSign(args: PreSignArgs): Promise<CoverDecision> {
    try {
      const walletAddress = await this.#signer.getAddress()
      if (!walletAddress) {
        return unavailable()
      }
      return await this.#client.preSign({
        walletPublicKey: walletAddress,
        userRef: '',
        transactionBytes: args.transactionBytes,
        ...(args.dappUrl === undefined ? {} : { dappUrl: args.dappUrl }),
      })
    } catch {
      return unavailable()
    }
  }

  async postSign(args: PostSignArgs): Promise<void> {
    try {
      await this.#client.postSign(args)
    } catch {
      // best-effort
    }
  }
}

/** The narrow cover surface a UI context may call over the proxy. */
export interface CoverUI {
  enroll(): Promise<boolean>
  isEnrolled(): Promise<boolean>
}

const COVER_SERVICE_KEY = 'ember.CoverService' as ProxyServiceKey<CoverUI>

/** SW only. Registers a narrow enroll/isEnrolled facade backed by the real provider. */
export function registerCoverService(provider: CoverProvider): void {
  const facade: CoverUI = {
    enroll: () => provider.enroll(),
    isEnrolled: () => provider.isEnrolled(),
  }
  registerService(COVER_SERVICE_KEY, facade)
}

/** Any UI context: a proxy to enroll/isEnrolled. */
export function getCoverService(): ProxyService<CoverUI> {
  return createProxyService<CoverUI>(COVER_SERVICE_KEY)
}
