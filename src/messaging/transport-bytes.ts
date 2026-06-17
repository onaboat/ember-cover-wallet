/**
 * Browser extension messaging (runtime AND custom-event AND proxy-service) serializes
 * Uint8Array to a plain object {0: n, 1: n, ...}. Reconstruct it or crypto verify fails.
 * Self-heals across realms: a cross-realm Uint8Array fails `instanceof` but Object.values
 * still yields its bytes.
 */
export function decodeTransportBytes(value: Record<string, number> | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(Object.values(value))
}
