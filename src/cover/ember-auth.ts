const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Decode(value: string): Uint8Array {
  const bytes: number[] = [0]
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char)
    if (digit === -1) {
      throw new Error('invalid base58 character')
    }
    let carry = digit
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] ?? 0) * 58
      bytes[i] = carry & 0xff
      carry = carry >> 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry = carry >> 8
    }
  }
  for (let i = 0; i < value.length && value[i] === '1'; i++) {
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] ?? 0) << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    out += '1'
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    out += BASE58_ALPHABET.charAt(digits[i] ?? 0)
  }
  return out
}

/** Canonical bytes the wallet signs and the Worker verifies for request auth. */
export function authPayload(method: string, path: string, timestamp: string, body: string): Uint8Array {
  return new TextEncoder().encode(`${method}\n${path}\n${timestamp}\n${body}`)
}

const MAX_CLOCK_SKEW_MS = 60_000

export interface VerifyAuthArgs {
  /** `${isoTimestamp}.${base64Signature}` */
  header: string
  method: string
  path: string
  body: string
  /** base58 Solana address of the signing wallet. */
  walletPublicKey: string
  nowMs: number
}

/**
 * Verifies the request was signed by the wallet key and is fresh (anti-replay).
 * Runs in the Worker so the proxy can only be driven for a pubkey the caller
 * actually controls — it is not an open relay.
 */
export async function verifyAuthHeader(args: VerifyAuthArgs): Promise<boolean> {
  // The ISO timestamp itself contains a '.' (milliseconds); base64 never does,
  // so the separator is the LAST '.'.
  const dot = args.header.lastIndexOf('.')
  if (dot <= 0) {
    return false
  }
  const timestamp = args.header.slice(0, dot)
  const signatureBase64 = args.header.slice(dot + 1)
  const tsMs = Date.parse(timestamp)
  if (Number.isNaN(tsMs) || Math.abs(args.nowMs - tsMs) > MAX_CLOCK_SKEW_MS) {
    return false
  }
  let publicKeyBytes: Uint8Array
  let signature: Uint8Array
  try {
    publicKeyBytes = base58Decode(args.walletPublicKey)
    signature = Uint8Array.from(atob(signatureBase64), (character) => character.charCodeAt(0))
  } catch {
    return false
  }
  if (publicKeyBytes.length !== 32 || signature.length !== 64) {
    return false
  }
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(publicKeyBytes), { name: 'Ed25519' }, false, [
      'verify',
    ])
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      new Uint8Array(signature),
      new Uint8Array(authPayload(args.method, args.path, timestamp, args.body)),
    )
  } catch {
    return false
  }
}
