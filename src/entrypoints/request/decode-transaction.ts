import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit'

import { decodeTransportBytes } from '../../messaging/transport-bytes.ts'

const KNOWN_PROGRAMS: Record<string, string> = {
  '11111111111111111111111111111111': 'System Program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token Program',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token 2022',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token',
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

export interface TxInstructionSummary {
  program: string
  programName: string
  instructionName: string | null
  accounts: string[]
}

export type TxActionKind =
  | 'sol_transfer'
  | 'token_transfer'
  | 'token_approval'
  | 'authority_change'
  | 'program_interaction'
  | 'unknown'

export interface TxPrimaryAction {
  kind: TxActionKind
  label: string
  amount: string | null
  tokenMint: string | null
  recipient: string | null
  source: string | null
}

export interface TxSummary {
  feePayer: string
  estimatedNetworkFee: string | null
  instructions: TxInstructionSummary[]
  primaryAction: TxPrimaryAction
  warnings: string[]
}

export type TxImpactTone = 'negative' | 'positive' | 'neutral' | 'unknown'

export interface TxImpactRow {
  label: string
  value: string
  tone: TxImpactTone
}

export interface TxWalletImpact {
  title: string
  rows: TxImpactRow[]
  isComplete: boolean
  warning: string | null
}

function u32le(bytes: Uint8Array, offset: number): number | null {
  if (bytes.length < offset + 4) {
    return null
  }
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)
}

function u64le(bytes: Uint8Array, offset: number): bigint | null {
  if (bytes.length < offset + 8) {
    return null
  }
  let value = 0n
  for (let i = 0; i < 8; i += 1) {
    value += BigInt(bytes[offset + i]!) << BigInt(i * 8)
  }
  return value
}

function formatIntegerAmount(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(Math.max(0, decimals))
  const whole = value / scale
  const fraction = value % scale
  const trimmedFraction = decimals > 0 ? fraction.toString().padStart(decimals, '0').replace(/0+$/, '') : ''
  return `${whole.toString()}${trimmedFraction ? `.${trimmedFraction}` : ''}`
}

function accountAt(accounts: readonly string[], index: number | undefined): string | null {
  return index === undefined ? null : accounts[index] ?? null
}

function isTokenProgram(program: string): boolean {
  return program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM
}

function parseInstructionAction(program: string, accounts: readonly string[], data?: Uint8Array): TxPrimaryAction | null {
  if (!data) {
    return null
  }
  if (program === SYSTEM_PROGRAM) {
    const instruction = u32le(data, 0)
    if (instruction === 2) {
      const lamports = u64le(data, 4)
      const source = accountAt(accounts, 0)
      const recipient = accountAt(accounts, 1)
      if (lamports !== null) {
        return {
          kind: 'sol_transfer',
          label: 'Send SOL',
          amount: `${formatIntegerAmount(lamports, 9)} SOL`,
          tokenMint: null,
          recipient,
          source,
        }
      }
    }
  }
  if (isTokenProgram(program)) {
    const instruction = data[0]
    if (instruction === 3 || instruction === 12) {
      const amount = u64le(data, 1)
      const source = accountAt(accounts, 0)
      const tokenMint = instruction === 12 ? accountAt(accounts, 1) : null
      const recipient = instruction === 12 ? accountAt(accounts, 2) : accountAt(accounts, 1)
      const decimals = instruction === 12 ? data[9] : undefined
      if (amount !== null) {
        return {
          kind: 'token_transfer',
          label: 'Send token',
          amount:
            decimals === undefined
              ? `${amount.toString()} raw token units`
              : `${formatIntegerAmount(amount, decimals)} tokens`,
          tokenMint,
          recipient,
          source,
        }
      }
    }
    if (instruction === 4 || instruction === 13) {
      const amount = u64le(data, 1)
      return {
        kind: 'token_approval',
        label: 'Approve token access',
        amount: amount === null ? null : `${amount.toString()} raw token units`,
        tokenMint: instruction === 13 ? accountAt(accounts, 1) : null,
        recipient: instruction === 13 ? accountAt(accounts, 2) : accountAt(accounts, 1),
        source: accountAt(accounts, 0),
      }
    }
    if (instruction === 6) {
      return {
        kind: 'authority_change',
        label: 'Change token authority',
        amount: null,
        tokenMint: null,
        recipient: accountAt(accounts, 2),
        source: accountAt(accounts, 0),
      }
    }
  }
  return null
}

function instructionName(program: string, data?: Uint8Array): string | null {
  if (!data) {
    return null
  }
  if (program === SYSTEM_PROGRAM && u32le(data, 0) === 2) {
    return 'Transfer'
  }
  if (isTokenProgram(program)) {
    switch (data[0]) {
      case 3:
        return 'Transfer'
      case 4:
        return 'Approve'
      case 6:
        return 'Set authority'
      case 12:
        return 'Transfer checked'
      case 13:
        return 'Approve checked'
    }
  }
  return null
}

function defaultAction(materialInstructionCount: number): TxPrimaryAction {
  return {
    kind: materialInstructionCount > 0 ? 'program_interaction' : 'unknown',
    label: materialInstructionCount > 1 ? 'Review complex transaction' : materialInstructionCount > 0 ? 'Review transaction' : 'Unknown transaction',
    amount: null,
    tokenMint: null,
    recipient: null,
    source: null,
  }
}

function shortAddress(value: string | null): string | null {
  return value && value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a === b
}

function unknownImpact(warning = 'Review the transaction details before signing.'): TxWalletImpact {
  return {
    title: 'Estimated changes',
    rows: [{ label: 'Balance changes', value: 'Could not be fully estimated', tone: 'unknown' }],
    isComplete: false,
    warning,
  }
}

function feeRow(summary: TxSummary, walletAddress: string): TxImpactRow[] {
  return sameAddress(summary.feePayer, walletAddress) && summary.estimatedNetworkFee
    ? [{ label: 'Network fee', value: `-${summary.estimatedNetworkFee}`, tone: 'negative' }]
    : []
}

function withFeeRows(rows: TxImpactRow[], summary: TxSummary, walletAddress: string): TxImpactRow[] {
  return [...rows, ...feeRow(summary, walletAddress)]
}

function unknownImpactForSummary(
  summary: TxSummary,
  walletAddress: string,
  warning = 'Review the transaction details before signing.',
  rows: TxImpactRow[] = [],
): TxWalletImpact {
  return {
    title: 'Estimated changes',
    rows: rows.length > 0
      ? withFeeRows(rows, summary, walletAddress)
      : withFeeRows([{ label: 'Balance changes', value: 'Could not be fully estimated', tone: 'unknown' }], summary, walletAddress),
    isComplete: false,
    warning,
  }
}

/**
 * Build a wallet-relative impact summary from what can be decoded locally.
 * This is intentionally conservative: if the wallet cannot confidently identify
 * the signed account as the source or recipient, the UI must say the impact is
 * not fully estimated instead of pretending to know.
 */
export function estimateWalletImpact(summary: TxSummary | null, walletAddress: string | null): TxWalletImpact {
  if (!summary || !walletAddress) {
    return unknownImpact()
  }

  const action = summary.primaryAction
  if (action.kind === 'sol_transfer' && action.amount) {
    if (sameAddress(action.source, walletAddress)) {
      return {
        title: 'Estimated changes',
        rows: withFeeRows([
          { label: 'You send', value: `-${action.amount}`, tone: 'negative' },
          ...(action.recipient ? [{ label: 'To', value: shortAddress(action.recipient) ?? action.recipient, tone: 'neutral' } as const] : []),
        ], summary, walletAddress),
        isComplete: true,
        warning: null,
      }
    }
    if (sameAddress(action.recipient, walletAddress)) {
      return {
        title: 'Estimated changes',
        rows: withFeeRows([
          { label: 'You receive', value: `+${action.amount}`, tone: 'positive' },
          ...(action.source ? [{ label: 'From', value: shortAddress(action.source) ?? action.source, tone: 'neutral' } as const] : []),
        ], summary, walletAddress),
        isComplete: true,
        warning: null,
      }
    }
    return unknownImpactForSummary(summary, walletAddress, 'This transfer does not clearly match the selected wallet.', [
      { label: 'Transfer amount', value: action.amount, tone: 'unknown' },
      ...(action.recipient ? [{ label: 'To', value: shortAddress(action.recipient) ?? action.recipient, tone: 'neutral' } as const] : []),
    ])
  }

  if (action.kind === 'token_transfer' && action.amount) {
    if (sameAddress(action.source, walletAddress)) {
      return {
        title: 'Estimated changes',
        rows: withFeeRows([
          { label: 'You send', value: `-${action.amount}`, tone: 'negative' },
          ...(action.recipient ? [{ label: 'To', value: shortAddress(action.recipient) ?? action.recipient, tone: 'neutral' } as const] : []),
        ], summary, walletAddress),
        isComplete: true,
        warning: null,
      }
    }
    if (sameAddress(action.recipient, walletAddress)) {
      return {
        title: 'Estimated changes',
        rows: withFeeRows([
          { label: 'You receive', value: `+${action.amount}`, tone: 'positive' },
          ...(action.source ? [{ label: 'From', value: shortAddress(action.source) ?? action.source, tone: 'neutral' } as const] : []),
        ], summary, walletAddress),
        isComplete: true,
        warning: null,
      }
    }
    return unknownImpactForSummary(summary, walletAddress, 'Token account ownership could not be fully estimated.', [
      { label: 'Token movement', value: action.amount, tone: 'unknown' },
      ...(action.recipient ? [{ label: 'To', value: shortAddress(action.recipient) ?? action.recipient, tone: 'neutral' } as const] : []),
    ])
  }

  if (action.kind === 'token_approval') {
    return unknownImpactForSummary(summary, walletAddress, 'This may let another account move tokens.', [
      ...(action.amount ? [{ label: 'Token access', value: action.amount, tone: 'unknown' } as const] : []),
      ...(action.recipient ? [{ label: 'Approved account', value: shortAddress(action.recipient) ?? action.recipient, tone: 'neutral' } as const] : []),
    ])
  }

  if (action.kind === 'authority_change') {
    return unknownImpactForSummary(summary, walletAddress, 'This may change who controls a token account.')
  }

  return unknownImpactForSummary(summary, walletAddress)
}

/**
 * Decode a transaction (raw bytes or the serialized `{0:n,...}` transport record) into a readable
 * summary: the fee payer (first static account) and a list of instructions (program address +
 * friendly name for known programs). Pure and defensive: returns null on any decode failure so a
 * malformed transaction can never crash the approval popup.
 */
export function decodeTransactionSummary(
  transaction: Uint8Array | Record<string, number>,
): TxSummary | null {
  try {
    const tx = getTransactionDecoder().decode(decodeTransportBytes(transaction))
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as {
      staticAccounts: readonly unknown[]
      instructions?: readonly {
        accountIndices?: readonly number[]
        data?: Uint8Array
        programAddressIndex: number
      }[]
      compiledInstructions?: readonly {
        accountIndices?: readonly number[]
        data?: Uint8Array
        programAddressIndex: number
      }[]
    }
    const accounts = message.staticAccounts
    const compiledInstructions = message.instructions ?? message.compiledInstructions ?? []
    const feePayer = accounts[0]
    if (!feePayer) {
      return null
    }
    const instructions = compiledInstructions.map((ix) => {
      const program = accounts[ix.programAddressIndex] ?? '(unknown)'
      const instructionAccounts = (ix.accountIndices ?? []).map((index) => String(accounts[index] ?? '(unknown)'))
      const programAddress = String(program)
      const data = ix.data ? new Uint8Array(ix.data) : undefined
      return {
        program: programAddress,
        programName: KNOWN_PROGRAMS[programAddress] ?? 'Program',
        instructionName: instructionName(programAddress, data),
        accounts: instructionAccounts,
      }
    })
    const materialInstructions = compiledInstructions.filter((ix) => String(accounts[ix.programAddressIndex]) !== COMPUTE_BUDGET_PROGRAM)
    const actions = materialInstructions
      .map((ix) => {
        const program = String(accounts[ix.programAddressIndex] ?? '')
        const instructionAccounts = (ix.accountIndices ?? []).map((index) => String(accounts[index] ?? '(unknown)'))
        return parseInstructionAction(program, instructionAccounts, ix.data ? new Uint8Array(ix.data) : undefined)
      })
      .filter((action): action is TxPrimaryAction => action !== null)
    const primaryAction = actions[0] ?? defaultAction(materialInstructions.length)
    const requiredSignatureCount = Object.keys(tx.signatures).length
    const estimatedNetworkFee = requiredSignatureCount > 0 ? `${formatIntegerAmount(BigInt(requiredSignatureCount) * 5000n, 9)} SOL` : null
    const warnings: string[] = []
    if (materialInstructions.length > 1) {
      warnings.push('This transaction has multiple instructions.')
    }
    if (primaryAction.kind === 'token_approval') {
      warnings.push('This transaction can grant another account token access.')
    }
    if (primaryAction.kind === 'authority_change') {
      warnings.push('This transaction can change token authority.')
    }
    if (primaryAction.kind === 'program_interaction') {
      warnings.push('This is not a simple transfer.')
    }
    return { feePayer: String(feePayer), estimatedNetworkFee, instructions, primaryAction, warnings }
  } catch {
    return null
  }
}
