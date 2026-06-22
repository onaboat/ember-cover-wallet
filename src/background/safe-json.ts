/**
 * JSON.stringify that survives bigint values. The Solana RPC parses u64s in
 * responses (e.g. simulation `err` payloads) into bigint, and plain
 * JSON.stringify throws "Do not know how to serialize a BigInt" on them.
 */
export function stringifyWithBigInts(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
}
