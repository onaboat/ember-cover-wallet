import { authPayload, base58Decode } from './ember-auth.ts'

const SESSION_AUTH_PREFIX = 'ember-session-authorization'
const MAX_CLOCK_SKEW_MS = 60_000

/** The canonical bytes a wallet signs ONCE to authorize a session key to act for it. */
export function sessionAuthorizationPayload(sessionPublicKey: string, walletPublicKey: string): Uint8Array {
  return new TextEncoder().encode(`${SESSION_AUTH_PREFIX}\n${sessionPublicKey}\n${walletPublicKey}`)
}

const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

async function verifyEd25519(publicKeyBase58: string, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  let pk: Uint8Array
  try {
    pk = base58Decode(publicKeyBase58)
  } catch {
    return false
  }
  if (pk.length !== 32 || signature.length !== 64) {
    return false
  }
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(pk), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), new Uint8Array(message))
  } catch {
    return false
  }
}

export interface VerifySessionAuthArgs {
  /** `${isoTimestamp}.${base64(sessionSig)}` */
  authHeader: string
  /** `${sessionPublicKey}.${base64(walletAuthSig)}` */
  sessionHeader: string
  method: string
  path: string
  body: string
  /** base58 of the wallet that must be a required tx signer; also the wallet that authorized the session key. */
  walletPublicKey: string
  nowMs: number
}

/**
 * Two-signature verify: (a) the wallet authorized this session key (one-time), and
 * (b) the session key signed this fresh request. The wallet key is never used per-request.
 */
export async function verifySessionAuth(args: VerifySessionAuthArgs): Promise<boolean> {
  // session header: sessionPublicKey is base58 (no '.'); the base64 sig has no '.'; split on the first '.'.
  const sdot = args.sessionHeader.indexOf('.')
  if (sdot <= 0) {
    return false
  }
  const sessionPublicKey = args.sessionHeader.slice(0, sdot)
  let walletAuthSig: Uint8Array
  try {
    walletAuthSig = unb64(args.sessionHeader.slice(sdot + 1))
  } catch {
    return false
  }
  // (a) the wallet authorized this session key
  const authorized = await verifyEd25519(
    args.walletPublicKey,
    walletAuthSig,
    sessionAuthorizationPayload(sessionPublicKey, args.walletPublicKey),
  )
  if (!authorized) {
    return false
  }
  // auth header: the ISO timestamp itself contains '.', base64 never does -> split on the LAST '.'.
  const adot = args.authHeader.lastIndexOf('.')
  if (adot <= 0) {
    return false
  }
  const timestamp = args.authHeader.slice(0, adot)
  const tsMs = Date.parse(timestamp)
  if (Number.isNaN(tsMs) || Math.abs(args.nowMs - tsMs) > MAX_CLOCK_SKEW_MS) {
    return false
  }
  let sessionSig: Uint8Array
  try {
    sessionSig = unb64(args.authHeader.slice(adot + 1))
  } catch {
    return false
  }
  // (b) the session key signed this fresh request
  return verifyEd25519(sessionPublicKey, sessionSig, authPayload(args.method, args.path, timestamp, args.body))
}
