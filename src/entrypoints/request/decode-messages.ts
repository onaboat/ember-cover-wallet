import { decodeTransportBytes } from '../../messaging/transport-bytes.ts'

const PRINTABLE = /^[\x09\x0a\x0d\x20-\x7e -￿]*$/

/** Decode each signMessage input.message for display. UTF-8 if printable, else hex. */
export function decodeMessages(data: { message: Uint8Array | Record<string, number> }[]): string {
  return data
    .map((input) => {
      const bytes = decodeTransportBytes(input.message)
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      if (PRINTABLE.test(text)) {
        return text
      }
      return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
    })
    .join('\n')
}
