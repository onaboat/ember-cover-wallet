import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { storage } from 'wxt/utils/storage'

import { EmberClient } from '../cover/ember-client.ts'
import type { CoverDebugInfo, CoverDecision } from '../cover/ember-types.ts'
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

function unavailable(debug?: CoverDebugInfo): CoverDecision {
  return {
    requestId: '',
    coverStatus: 'unavailable',
    riskBand: 'severe',
    reasonCodes: [],
    decisionExpiresAt: new Date(0).toISOString(),
    ...(debug === undefined ? {} : { debug }),
  }
}

function notCovered(debug?: CoverDebugInfo): CoverDecision {
  return {
    requestId: '',
    coverStatus: 'not_covered',
    riskBand: 'low',
    reasonCodes: [],
    decisionExpiresAt: new Date(0).toISOString(),
    ...(debug === undefined ? {} : { debug }),
  }
}

async function activeEnrollmentForWallet(walletAddress: string): Promise<Enrollment | null> {
  const e = await storage.getItem<Enrollment>(ENROLL_KEY)
  if (!e || e.walletAddress !== walletAddress) {
    return null
  }
  const sessionPublicKey = await getSessionPublicKey()
  if (e.sessionPublicKey !== sessionPublicKey) {
    return null
  }
  return e
}

export async function coverSessionHeaderForWallet(walletAddress: string): Promise<string | undefined> {
  const e = await activeEnrollmentForWallet(walletAddress)
  return e ? `${e.sessionPublicKey}.${e.walletAuthSig}` : undefined
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
    const e = await this.#activeEnrollment()
    return e ? `${e.sessionPublicKey}.${e.walletAuthSig}` : undefined
  }

  async #activeEnrollment(walletAddress?: string): Promise<Enrollment | null> {
    const currentWalletAddress = walletAddress ?? (await this.#signer.getAddress())
    if (!currentWalletAddress) {
      return null
    }
    return await activeEnrollmentForWallet(currentWalletAddress)
  }

  async isEnrolled(): Promise<boolean> {
    return (await this.#activeEnrollment()) !== null
  }

  /** One-time: vault authorizes the session key + registers the vault address. Needs unlock. */
  async enroll(): Promise<boolean> {
    const walletAddress = await this.#signer.getAddress()
    if (!walletAddress) {
      return false
    }
    const sessionPublicKey = await getSessionPublicKey()
    const walletAuthSig = await this.#signer.sign(sessionAuthorizationPayload(sessionPublicKey, walletAddress))
    // Persist the authorization first — register's two-sig header reads it from storage.
    await storage.setItem<Enrollment>(ENROLL_KEY, {
      sessionPublicKey,
      walletAuthSig: b64(walletAuthSig),
      walletAddress,
    })
    // Register the vault address; the NONCE is signed by the vault key (proves control of it).
    const registered = await this.#client.register(walletAddress, (m) => this.#signer.sign(m))
    if (!registered) {
      // Roll back: a failed registration must NOT leave the wallet looking "enrolled".
      await storage.removeItem(ENROLL_KEY)
    }
    return registered
  }

  async preSign(args: PreSignArgs): Promise<CoverDecision> {
    try {
      const walletAddress = await this.#signer.getAddress()
      if (!walletAddress) {
        return unavailable({
          stage: 'no_wallet',
          apiAttempted: false,
          proxyBaseUrl: COVER_CONFIG.proxyBaseUrl,
        })
      }
      if (!(await this.#activeEnrollment(walletAddress))) {
        return notCovered({
          stage: 'not_enrolled',
          apiAttempted: false,
          proxyBaseUrl: COVER_CONFIG.proxyBaseUrl,
          walletAddress,
          enrolled: false,
          ...(args.dappUrl === undefined ? {} : { dappUrl: args.dappUrl }),
        })
      }
      const decision = await this.#client.preSign({
        walletPublicKey: walletAddress,
        userRef: '',
        transactionBytes: args.transactionBytes,
        ...(args.dappUrl === undefined ? {} : { dappUrl: args.dappUrl }),
      })
      return {
        ...decision,
        debug: {
          ...decision.debug,
          enrolled: true,
        } as CoverDebugInfo,
      }
    } catch {
      return unavailable({
        stage: 'provider_error',
        apiAttempted: false,
        proxyBaseUrl: COVER_CONFIG.proxyBaseUrl,
      })
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
