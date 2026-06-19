const QR_VERSION = 4
const QR_SIZE = 33
const DATA_CODEWORDS = 80
const ERROR_CODEWORDS = 20
const FORMAT_BITS_L_MASK_0 = 0x77c4

type QrMatrix = boolean[][]

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

function appendBits(bits: boolean[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    bits.push(bit(value, i))
  }
}

function bytesFor(value: string): number[] {
  return Array.from(new TextEncoder().encode(value))
}

function dataCodewords(value: string): number[] {
  const data = bytesFor(value)
  if (data.length > 78) {
    throw new Error('QR content is too long')
  }
  const bits: boolean[] = []
  appendBits(bits, 0b0100, 4)
  appendBits(bits, data.length, 8)
  for (const byte of data) {
    appendBits(bits, byte, 8)
  }
  const remaining = DATA_CODEWORDS * 8 - bits.length
  appendBits(bits, 0, Math.min(4, remaining))
  while (bits.length % 8 !== 0) {
    bits.push(false)
  }
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | (bits[i + j] ? 1 : 0)
    }
    codewords.push(byte)
  }
  for (let pad = 0xec; codewords.length < DATA_CODEWORDS; pad = pad === 0xec ? 0x11 : 0xec) {
    codewords.push(pad)
  }
  return codewords
}

function reedSolomonTables() {
  const exp = new Array<number>(512).fill(0)
  const log = new Array<number>(256).fill(0)
  let x = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = x
    log[x] = i
    x <<= 1
    if (x & 0x100) {
      x ^= 0x11d
    }
  }
  for (let i = 255; i < 512; i++) {
    exp[i] = exp[i - 255] ?? 0
  }
  return { exp, log }
}

const RS = reedSolomonTables()

function reedMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) {
    return 0
  }
  return RS.exp[(RS.log[left] ?? 0) + (RS.log[right] ?? 0)] ?? 0
}

function reedDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = reedMultiply(result[j] ?? 0, root)
      if (j + 1 < degree) {
        result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0)
      }
    }
    root = reedMultiply(root, 2)
  }
  return result
}

function reedRemainder(data: number[], degree: number): number[] {
  const divisor = reedDivisor(degree)
  const result = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0)
    result.push(0)
    for (let i = 0; i < degree; i++) {
      result[i] = (result[i] ?? 0) ^ reedMultiply(divisor[i] ?? 0, factor)
    }
  }
  return result
}

function emptyMatrix() {
  return {
    modules: Array.from({ length: QR_SIZE }, () => new Array<boolean>(QR_SIZE).fill(false)),
    reserved: Array.from({ length: QR_SIZE }, () => new Array<boolean>(QR_SIZE).fill(false)),
  }
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row < QR_SIZE && col < QR_SIZE
}

function setCell(
  modules: boolean[][],
  reserved: boolean[][],
  row: number,
  col: number,
  dark: boolean,
  reserve: boolean,
): void {
  if (!inBounds(row, col)) {
    return
  }
  modules[row]![col] = dark
  if (reserve) {
    reserved[row]![col] = true
  }
}

function drawFinder(modules: boolean[][], reserved: boolean[][], row: number, col: number): void {
  for (let y = -1; y <= 7; y++) {
    for (let x = -1; x <= 7; x++) {
      const yy = row + y
      const xx = col + x
      if (!inBounds(yy, xx)) {
        continue
      }
      const dark = y >= 0 && y <= 6 && x >= 0 && x <= 6 && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4))
      setCell(modules, reserved, yy, xx, dark, true)
    }
  }
}

function drawAlignment(modules: boolean[][], reserved: boolean[][], centerRow: number, centerCol: number): void {
  if (reserved[centerRow]?.[centerCol]) {
    return
  }
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      const dark = Math.max(Math.abs(x), Math.abs(y)) === 2 || (x === 0 && y === 0)
      setCell(modules, reserved, centerRow + y, centerCol + x, dark, true)
    }
  }
}

function drawFunctionPatterns(modules: boolean[][], reserved: boolean[][]): void {
  drawFinder(modules, reserved, 0, 0)
  drawFinder(modules, reserved, 0, QR_SIZE - 7)
  drawFinder(modules, reserved, QR_SIZE - 7, 0)

  for (let i = 8; i < QR_SIZE - 8; i++) {
    const dark = i % 2 === 0
    setCell(modules, reserved, 6, i, dark, true)
    setCell(modules, reserved, i, 6, dark, true)
  }

  for (const row of [6, 26]) {
    for (const col of [6, 26]) {
      drawAlignment(modules, reserved, row, col)
    }
  }

  setCell(modules, reserved, 4 * QR_VERSION + 9, 8, true, true)

  for (let i = 0; i <= 5; i++) setCell(modules, reserved, 8, i, false, true)
  setCell(modules, reserved, 8, 7, false, true)
  setCell(modules, reserved, 8, 8, false, true)
  setCell(modules, reserved, 7, 8, false, true)
  for (let i = 9; i < 15; i++) setCell(modules, reserved, 14 - i, 8, false, true)
  for (let i = 0; i < 8; i++) setCell(modules, reserved, QR_SIZE - 1 - i, 8, false, true)
  for (let i = 8; i < 15; i++) setCell(modules, reserved, 8, QR_SIZE - 15 + i, false, true)
}

function drawFormatBits(modules: boolean[][]): void {
  const set = (row: number, col: number, index: number) => {
    modules[row]![col] = bit(FORMAT_BITS_L_MASK_0, index)
  }
  for (let i = 0; i <= 5; i++) set(8, i, i)
  set(8, 7, 6)
  set(8, 8, 7)
  set(7, 8, 8)
  for (let i = 9; i < 15; i++) set(14 - i, 8, i)
  for (let i = 0; i < 8; i++) set(QR_SIZE - 1 - i, 8, i)
  for (let i = 8; i < 15; i++) set(8, QR_SIZE - 15 + i, i)
}

function drawData(modules: boolean[][], reserved: boolean[][], bytes: number[]): void {
  const bits = bytes.flatMap((byte) => Array.from({ length: 8 }, (_, i) => bit(byte, 7 - i)))
  let bitIndex = 0
  let upward = true
  for (let col = QR_SIZE - 1; col >= 1; col -= 2) {
    if (col === 6) {
      col--
    }
    for (let rowOffset = 0; rowOffset < QR_SIZE; rowOffset++) {
      const row = upward ? QR_SIZE - 1 - rowOffset : rowOffset
      for (const currentCol of [col, col - 1]) {
        if (reserved[row]?.[currentCol]) {
          continue
        }
        const rawBit = bits[bitIndex] ?? false
        const masked = rawBit !== ((row + currentCol) % 2 === 0)
        modules[row]![currentCol] = masked
        bitIndex++
      }
    }
    upward = !upward
  }
}

export function createQrMatrix(value: string): QrMatrix {
  const { modules, reserved } = emptyMatrix()
  drawFunctionPatterns(modules, reserved)
  const data = dataCodewords(value)
  const error = reedRemainder(data, ERROR_CODEWORDS)
  drawData(modules, reserved, [...data, ...error])
  drawFormatBits(modules)
  return modules
}

export function QrCode({ value }: { value: string }) {
  const matrix = createQrMatrix(value)
  const quiet = 4
  const size = matrix.length + quiet * 2
  return (
    <svg
      aria-label="Wallet address QR code"
      data-testid="receive-qr"
      role="img"
      style={{ background: '#fff', height: 176, width: 176 }}
      viewBox={`0 0 ${size} ${size}`}
    >
      <rect fill="#fff" height={size} width={size} x={0} y={0} />
      {matrix.flatMap((row, y) =>
        row.map((dark, x) =>
          dark ? <rect fill="#000" height={1} key={`${x}-${y}`} width={1} x={x + quiet} y={y + quiet} /> : null,
        ),
      )}
    </svg>
  )
}
