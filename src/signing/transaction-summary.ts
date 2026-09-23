import type { SigningDisposition } from './signing-policy.ts'
import { getAddressDecoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, isSome } from '@solana/kit'
import { getSetAuthorityInstructionDataDecoder } from '@solana-program/token'

import { decodeTransportBytes } from '../messaging/transport-bytes.ts'

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
  effect: TxInstructionEffect
}

/** Every instruction retains either its decoded action or explicit uncertainty. */
export type TxInstructionEffect =
  | { status: 'understood'; action: TxPrimaryAction }
  | { status: 'configuration' }
  | { status: 'unknown' }

export type TxActionKind =
  | 'sol_transfer'
  | 'account_creation'
  | 'token_mint'
  | 'token_setup'
  | 'token_transfer'
  | 'token_approval'
  | 'authority_change'
  | 'program_interaction'
  | 'unknown'

interface TxActionDetails {
  label: string
  amount: string | null
  tokenMint: string | null
  recipient: string | null
  source: string | null
}

export type TxPrimaryAction = TxActionDetails & (
  | { kind: 'sol_transfer' | 'account_creation'; lamports: bigint; amount: string; source: string; recipient: string }
  | { kind: Exclude<TxActionKind, 'sol_transfer' | 'account_creation'> }
)

export interface TxSummary {
  feePayer: string
  estimatedNetworkFee: string | null
  instructions: TxInstructionSummary[]
  primaryAction: TxPrimaryAction
  warnings: string[]
  signingBlock: Extract<SigningDisposition, { status: 'block' }> | null
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
  if (!data || accounts.some((account) => account === '(unknown)')) {
    return null
  }
  if (program === SYSTEM_PROGRAM) {
    const instruction = u32le(data, 0)
    if (instruction === 2 || instruction === 0) {
      const lamports = u64le(data, 4)
      const source = accountAt(accounts, 0)
      const recipient = accountAt(accounts, 1)
      if (lamports !== null && data.length === (instruction === 0 ? 52 : 12) && source && recipient) {
        return {
          kind: instruction === 0 ? 'account_creation' : 'sol_transfer',
          lamports,
          label: instruction === 0 ? 'Fund new account' : 'Send SOL',
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
    if (instruction === 7 || instruction === 14) {
      const amount = u64le(data, 1)
      if (amount === null || accounts.length < 3 || data.length !== (instruction === 14 ? 10 : 9)) return null
      return { kind: 'token_mint', label: 'Mint tokens',
        amount: instruction === 14 ? `${formatIntegerAmount(amount, data[9]!)} tokens` : `${amount} raw token units`,
        tokenMint: accountAt(accounts, 0), recipient: accountAt(accounts, 1), source: null }
    }
    const mintInitialization = (instruction === 0 || instruction === 20)
      && accounts.length >= (instruction === 0 ? 2 : 1)
      && (data[34] === 0 || data[34] === 1) && data.length === (data[34] === 1 ? 67 : 35)
    const accountInitialization = (instruction === 1 && accounts.length >= 4 && data.length === 1)
      || (instruction === 16 && accounts.length >= 3 && data.length === 33)
      || (instruction === 18 && accounts.length >= 2 && data.length === 33)
    const syncNative = instruction === 17 && accounts.length >= 1 && data.length === 1
    const revoke = instruction === 5 && accounts.length >= 2 && data.length === 1
    if (mintInitialization || accountInitialization || syncNative || revoke) {
      return { kind: 'token_setup', label: mintInitialization ? 'Initialize mint' : accountInitialization ? 'Initialize token account' : syncNative ? 'Synchronize wrapped SOL' : 'Revoke token access',
        amount: null, source: accountAt(accounts, 0), recipient: null,
        tokenMint: mintInitialization ? accountAt(accounts, 0) : accountInitialization ? accountAt(accounts, 1) : null }
    }
    if (instruction === 3 || instruction === 12) {
      const amount = u64le(data, 1)
      const source = accountAt(accounts, 0)
      const tokenMint = instruction === 12 ? accountAt(accounts, 1) : null
      const recipient = instruction === 12 ? accountAt(accounts, 2) : accountAt(accounts, 1)
      const decimals = instruction === 12 ? data[9] : undefined
      if (amount !== null && source && recipient && accounts.length >= (instruction === 12 ? 4 : 3) && data.length === (instruction === 12 ? 10 : 9)) {
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
      if (amount === null || accounts.length < (instruction === 13 ? 4 : 3) || data.length !== (instruction === 13 ? 10 : 9)) return null
      return {
        kind: 'token_approval',
        label: 'Approve token access',
        amount: instruction === 13 ? `${formatIntegerAmount(amount, data[9]!)} tokens` : `${amount.toString()} raw token units`,
        tokenMint: instruction === 13 ? accountAt(accounts, 1) : null,
        recipient: instruction === 13 ? accountAt(accounts, 2) : accountAt(accounts, 1),
        source: accountAt(accounts, 0),
      }
    }
    if (instruction === 6) {
      // New authority is encoded in instruction data, not an account meta.
      if (accounts.length < 2 || (data.length !== 3 && data.length !== 35) || data[1]! > 3 || data[2]! > 1 || data.length !== (data[2] === 1 ? 35 : 3)) return null
      const decoded = getSetAuthorityInstructionDataDecoder().decode(data)
      const authorityNames = ['mint', 'freeze', 'owner', 'close']
      return {
        kind: 'authority_change',
        label: `Change token ${authorityNames[decoded.authorityType]} authority`,
        amount: null,
        tokenMint: null,
        recipient: isSome(decoded.newAuthority) ? decoded.newAuthority.value : null,
        source: accountAt(accounts, 0),
      }
    }
  }
  return null
}

function instructionSigningBlock(program: string, accounts: readonly string[], data?: Uint8Array): Extract<SigningDisposition, { status: 'block' }> | null {
  if (!isTokenProgram(program) || !data) return null
  const tag = data[0]
  // Match executable token semantics, including accepted trailing bytes and
  // irrelevant unresolved metas. Display completeness is a separate concern.
  if ((tag === 4 || tag === 13) && accounts.length >= (tag === 13 ? 4 : 3)
    && data.length >= (tag === 13 ? 10 : 9) && u64le(data, 1) === 18_446_744_073_709_551_615n) {
    return { status: 'block', reason: 'unlimited_token_access' }
  }
  if (tag === 6 && accounts.length >= 2 && (data[1]! <= 3 || (program === TOKEN_2022_PROGRAM && data[1] === 8)) && data[2] === 1 && data.length >= 35) {
    const current = accounts[1]
    const newAuthority = getAddressDecoder().decode(data.subarray(3, 35))
    if (current && current !== '(unknown)' && newAuthority !== current) {
      return { status: 'block', reason: 'authority_handover' }
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

function unknownImpact(): TxWalletImpact {
  return {
    title: 'Estimated changes',
    rows: [{ label: 'Balance changes', value: 'Could not be fully estimated', tone: 'unknown' }],
    isComplete: false,
    warning: 'Review the transaction details before signing.',
  }
}

/** Pure, wallet-relative interpretation of ALL instructions. No token ownership is inferred. */
export function estimateWalletImpact(summary: TxSummary | null, walletAddress: string | null): TxWalletImpact {
  if (!summary || !walletAddress) return unknownImpact()

  const rows: TxImpactRow[] = []
  const warnings = new Set<string>()
  let outgoing = 0n
  let incoming = 0n
  let solTransferCount = 0
  for (const [index, instruction] of summary.instructions.entries()) {
    const effect = instruction.effect
    if (effect.status === 'configuration') continue
    if (effect.status === 'unknown') {
      rows.push({ label: `Instruction ${index + 1}: ${instruction.programName}`, value: 'Effects unknown', tone: 'unknown' })
      warnings.add('Some instruction effects could not be estimated. Shown movements may not be the full transaction impact.')
      continue
    }
    const action = effect.action
    if (action.kind === 'sol_transfer' || action.kind === 'account_creation') {
      solTransferCount += 1
      if (action.source === walletAddress && action.recipient === walletAddress) {
        rows.push({ label: 'Self-transfer', value: `${action.amount} (no net SOL movement)`, tone: 'neutral' })
      } else if (action.source === walletAddress) {
        outgoing += action.lamports
        rows.push({ label: action.kind === 'account_creation' ? 'New account funding' : 'Outgoing', value: `-${action.amount}`, tone: 'negative' })
        rows.push({ label: 'To', value: action.recipient, tone: 'neutral' })
      } else if (action.recipient === walletAddress) {
        incoming += action.lamports
        rows.push({ label: 'Incoming', value: `+${action.amount}`, tone: 'positive' })
        rows.push({ label: 'From', value: action.source, tone: 'neutral' })
      } else {
        rows.push({ label: 'Other SOL transfer', value: action.amount, tone: 'neutral' })
        rows.push({ label: 'From', value: action.source, tone: 'neutral' }, { label: 'To', value: action.recipient, tone: 'neutral' })
      }
    } else if (action.kind === 'token_transfer' || action.kind === 'token_approval') {
      rows.push({ label: action.kind === 'token_transfer' ? 'Token movement' : 'Token access', value: action.amount ?? 'Unknown amount', tone: 'unknown' })
      if (action.source) rows.push({ label: 'Token account', value: action.source, tone: 'neutral' })
      if (action.recipient) rows.push({ label: action.kind === 'token_transfer' ? 'To token account' : 'Approved account', value: action.recipient, tone: 'neutral' })
      if (action.tokenMint) rows.push({ label: 'Token mint', value: action.tokenMint, tone: 'neutral' })
      warnings.add(action.kind === 'token_transfer' ? 'Token account ownership and additional token effects could not be fully estimated.' : 'This may let another account move tokens.')
    } else if (action.kind === 'token_mint' || action.kind === 'token_setup') {
      rows.push({ label: action.label, value: action.amount ?? 'Account configuration', tone: 'neutral' })
      if (action.source) rows.push({ label: 'Affected account', value: action.source, tone: 'neutral' })
      if (action.recipient) rows.push({ label: 'To token account', value: action.recipient, tone: 'neutral' })
      if (action.tokenMint) rows.push({ label: 'Token mint', value: action.tokenMint, tone: 'neutral' })
      warnings.add('Token account ownership and resulting token balances require simulation.')
    } else if (action.kind === 'authority_change') {
      rows.push({ label: 'Authority change', value: action.label, tone: 'unknown' })
      if (action.source) rows.push({ label: 'Affected account', value: action.source, tone: 'neutral' })
      rows.push({ label: 'New authority', value: action.recipient ?? 'Authority removed', tone: 'neutral' })
      warnings.add('This may change who controls a token account or mint.')
    }
  }
  if (solTransferCount > 1) {
    if (outgoing > 0n) rows.push({ label: 'Total outgoing SOL', value: `-${formatIntegerAmount(outgoing, 9)} SOL`, tone: 'negative' })
    if (incoming > 0n) rows.push({ label: 'Total incoming SOL', value: `+${formatIntegerAmount(incoming, 9)} SOL`, tone: 'positive' })
  }
  if (rows.length === 0) {
    rows.push(...unknownImpact().rows)
    warnings.add('Review the transaction details before signing.')
  }
  if (summary.feePayer === walletAddress && summary.estimatedNetworkFee) {
    rows.push({ label: 'Base network fee', value: `-${summary.estimatedNetworkFee}`, tone: 'negative' })
  }
  return { title: 'Estimated changes', rows, isComplete: warnings.size === 0, warning: warnings.size ? [...warnings].join(' ') : null }
}

// Only supported zero-price compute configuration is excluded from movement analysis.
// Priority fees need runtime/default compute-limit context, so retain explicit uncertainty.
function isUnderstoodConfiguration(program: string, data: Uint8Array | undefined): boolean {
  if (program !== COMPUTE_BUDGET_PROGRAM || !data) return false
  return ((data[0] === 1 || data[0] === 2 || data[0] === 4) && data.length === 5)
    || (data[0] === 3 && data.length === 9 && u64le(data, 1) === 0n)
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
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
    // This local display supports the legacy and v0 message layouts only.
    if (message.version !== 'legacy' && message.version !== 0) return null
    const accounts = message.staticAccounts
    const compiledInstructions = message.instructions
    const feePayer = accounts[0]
    if (!feePayer) {
      return null
    }
    let signingBlock: TxSummary['signingBlock'] = null
    const instructions = compiledInstructions.map((ix) => {
      const program = accounts[ix.programAddressIndex] ?? '(unknown)'
      const instructionAccounts = (ix.accountIndices ?? []).map((index) => String(accounts[index] ?? '(unknown)'))
      const programAddress = String(program)
      const data = ix.data ? new Uint8Array(ix.data) : undefined
      signingBlock ??= instructionSigningBlock(programAddress, instructionAccounts, data)
      const action = parseInstructionAction(programAddress, instructionAccounts, data)
      const effect: TxInstructionEffect = action
        ? { status: 'understood', action }
        : isUnderstoodConfiguration(programAddress, data) ? { status: 'configuration' } : { status: 'unknown' }
      return {
        effect,
        program: programAddress,
        programName: KNOWN_PROGRAMS[programAddress] ?? 'Program',
        instructionName: instructionName(programAddress, data) ?? action?.label ?? null,
        accounts: instructionAccounts,
      }
    })
    const materialInstructions = instructions.filter((ix) => ix.effect.status !== 'configuration')
    const actions = materialInstructions.flatMap((ix) => ix.effect.status === 'understood' ? [ix.effect.action] : [])
    // A composed transaction must not be titled or recorded as only its first action.
    const primaryAction = materialInstructions.length === 1 && actions.length === 1
      ? actions[0]!
      : defaultAction(materialInstructions.length)
    const requiredSignatureCount = Object.keys(tx.signatures).length
    const estimatedNetworkFee = requiredSignatureCount > 0 ? `${formatIntegerAmount(BigInt(requiredSignatureCount) * 5000n, 9)} SOL` : null
    const warnings: string[] = []
    if (materialInstructions.length > 1) {
      warnings.push('This transaction has multiple instructions.')
    }
    if (actions.some((action) => action.kind === 'token_approval')) {
      warnings.push('This transaction can grant another account token access.')
    }
    if (actions.some((action) => action.kind === 'authority_change')) {
      warnings.push('This transaction can change token authority.')
    }
    if (primaryAction.kind === 'program_interaction') {
      warnings.push('This is not a simple transfer.')
    }
    return { feePayer: String(feePayer), estimatedNetworkFee, instructions, primaryAction, warnings, signingBlock }
  } catch {
    return null
  }
}
