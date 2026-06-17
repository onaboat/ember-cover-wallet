import { base58Encode } from './ember-auth.ts'
import { COVER_DEBUG, coverDebug } from './cover-debug.ts'
import type { EmberConfig } from './ember-config.ts'
import type { CoverDebugInfo, CoverDecision } from './ember-types.ts'

/** Signs an arbitrary message with the wallet key (injected from vault/keypair). */
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>

export interface PreSignRequest {
  walletPublicKey: string
  userRef: string
  /** base64 of the FINAL bytes the wallet will sign (post finalization). */
  transactionBytes: string
  dappUrl?: string
  dappProgramId?: string
}

export interface PostSignRequest {
  requestId: string
  signedBytes: string
  signature?: string
  signingWalletPublicKey: string
  walletTimestamp: string
  highRiskAckAt?: string
}

export interface EmberClientDeps {
  fetch?: typeof fetch
  now?: () => number
  /** Returns the `x-ember-session` header value (the wallet's one-time authorization of the session key), or undefined if not enrolled. */
  sessionAuthHeader?: () => Promise<string | undefined>
}

const POST_SIGN_TIMEOUT_MS = 10_000
const POST_SIGN_ATTEMPTS = 3

/**
 * Talks to the apps/api Worker proxy (never the Ember API directly, so no key
 * in client code). Every request is signed with the wallet key. Pre-sign fails
 * open; post-sign is best-effort and never throws into the signing path.
 */
export class EmberClient {
  private cfg: EmberConfig
  private signMessage: SignMessage
  private fetchFn: typeof fetch
  private now: () => number
  private sessionAuthHeader: (() => Promise<string | undefined>) | undefined

  constructor(cfg: EmberConfig, signMessage: SignMessage, deps: EmberClientDeps = {}) {
    this.cfg = cfg
    this.signMessage = signMessage
    // Bind to the global: a bare `fetch` reference called as `this.fetchFn(...)` loses its
    // receiver and throws "Illegal invocation" in a service worker (WorkerGlobalScope).
    this.fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = deps.now ?? Date.now
    this.sessionAuthHeader = deps.sessionAuthHeader
  }

  async preSign(req: PreSignRequest): Promise<CoverDecision> {
    const payload = { ...req, chain: 'solana', cluster: this.cfg.cluster }
    try {
      const res = await this.post('/cover/pre-sign', payload, this.cfg.preSignTimeoutMs)
      if (!res.ok) {
        const body = await res.text()
        coverDebug('pre-sign non-ok', { status: res.status, body })
        return unavailable(COVER_DEBUG ? [`pre-sign ${res.status}: ${body.slice(0, 140)}`] : [], {
          stage: 'api_pre_sign_non_ok',
          apiAttempted: true,
          proxyBaseUrl: this.cfg.proxyBaseUrl,
          walletAddress: req.walletPublicKey,
          httpStatus: res.status,
          error: `HTTP ${res.status}`,
          ...(req.dappUrl === undefined ? {} : { dappUrl: req.dappUrl }),
        })
      }
      const decision = (await res.json()) as CoverDecision
      coverDebug('pre-sign ok', decision)
      return {
        ...decision,
        debug: {
          stage: 'api_pre_sign_ok',
          apiAttempted: true,
          proxyBaseUrl: this.cfg.proxyBaseUrl,
          walletAddress: req.walletPublicKey,
          requestId: decision.requestId,
          coverStatus: decision.coverStatus,
          riskBand: decision.riskBand,
          decisionExpiresAt: decision.decisionExpiresAt,
          reasonCodeCount: decision.reasonCodes.length,
          ...(req.dappUrl === undefined ? {} : { dappUrl: req.dappUrl }),
        },
      }
    } catch (err) {
      coverDebug('pre-sign error', String(err))
      return unavailable(COVER_DEBUG ? [`pre-sign error: ${String(err)}`] : [], {
        stage: 'api_pre_sign_error',
        apiAttempted: true,
        proxyBaseUrl: this.cfg.proxyBaseUrl,
        walletAddress: req.walletPublicKey,
        error: String(err),
        ...(req.dappUrl === undefined ? {} : { dappUrl: req.dappUrl }),
      })
    }
  }

  async postSign(req: PostSignRequest): Promise<void> {
    for (let attempt = 0; attempt < POST_SIGN_ATTEMPTS; attempt++) {
      try {
        const res = await this.post('/cover/post-sign', req, POST_SIGN_TIMEOUT_MS)
        if (res.ok) return
      } catch {
        // best-effort: swallow and retry; never throw into the signing path
      }
    }
  }

  async register(walletPublicKey: string, walletSign?: SignMessage): Promise<boolean> {
    try {
      const nonceRes = await this.post('/wallets/register/nonce', { walletPublicKey }, POST_SIGN_TIMEOUT_MS)
      if (!nonceRes.ok) return false
      const { nonce } = (await nonceRes.json()) as { nonce: string }
      // Must match the backend's registration_message() in
      // crates/ember-api/src/registration.rs exactly, or verification fails.
      // The backend parses this signature with Solana's Signature::from_str (base58),
      // NOT base64, unlike the x-ember-auth header which the Worker verifies as base64.
      // The API verifies the nonce signature against `walletPublicKey` (the vault), so the
      // nonce must be vault-signed; `walletSign` lets a DIFFERENT key sign it than the request
      // envelope (the session key).
      const message = `Ember wallet registration: ${nonce}`
      const sign = walletSign ?? this.signMessage
      const signature = base58Encode(await sign(new TextEncoder().encode(message)))
      const res = await this.post('/wallets/register', { walletPublicKey, nonce, signature }, POST_SIGN_TIMEOUT_MS)
      return res.ok
    } catch {
      return false
    }
  }

  private async authHeader(method: string, path: string, body: string): Promise<string> {
    const ts = new Date(this.now()).toISOString()
    const payload = `${method}\n${path}\n${ts}\n${body}`
    const sig = await this.signMessage(new TextEncoder().encode(payload))
    return `${ts}.${toBase64(sig)}`
  }

  private async post(path: string, payload: unknown, timeoutMs: number): Promise<Response> {
    const body = JSON.stringify(payload)
    const header = await this.authHeader('POST', path, body)
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-ember-auth': header }
    const sessionHeader = this.sessionAuthHeader ? await this.sessionAuthHeader() : undefined
    if (sessionHeader) {
      headers['x-ember-session'] = sessionHeader
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('ember_timeout'))
      }, timeoutMs)
    })
    try {
      return await Promise.race([
        this.fetchFn(this.cfg.proxyBaseUrl + path, {
          method: 'POST',
          signal: controller.signal,
          headers,
          body,
        }),
        timeout,
      ])
    } finally {
      clearTimeout(timer!)
    }
  }
}

function unavailable(reasonCodes: string[] = [], debug?: CoverDebugInfo): CoverDecision {
  return {
    requestId: '',
    coverStatus: 'unavailable',
    riskBand: 'severe',
    reasonCodes,
    decisionExpiresAt: new Date(0).toISOString(),
    ...(debug === undefined ? {} : { debug }),
  }
}

/** base64 of bytes; works in browser, worker, and node test runtimes. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
