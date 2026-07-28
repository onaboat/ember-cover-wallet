const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Decode(value: string): Uint8Array {
  const bytes: number[] = [0]
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char)
    if (digit === -1) throw new Error('invalid base58 character')
    let carry = digit
    for (let index = 0; index < bytes.length; index += 1) {
      carry += (bytes[index] ?? 0) * 58
      bytes[index] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (let index = 0; index < value.length && value[index] === '1'; index += 1) {
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += (digits[index] ?? 0) << 8
      digits[index] = carry % 58
      carry = Math.trunc(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.trunc(carry / 58)
    }
  }
  let output = ''
  for (let index = 0; index < bytes.length && bytes[index] === 0; index += 1) {
    output += '1'
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += BASE58_ALPHABET.charAt(digits[index] ?? 0)
  }
  return output
}
