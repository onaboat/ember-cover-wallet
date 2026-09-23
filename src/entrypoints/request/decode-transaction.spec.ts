import {
  AccountRole,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  address as toAddress,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  getAddressEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { expect, test } from 'vitest'

import { decodeTransactionSummary, estimateWalletImpact } from './decode-transaction.ts'

const FEE_PAYER = 'So11111111111111111111111111111111111111112'
const RECIPIENT = '11111111111111111111111111111112'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]
}

function u64le(value: bigint): number[] {
  const out: number[] = []
  for (let i = 0; i < 8; i += 1) {
    out.push(Number((value >> BigInt(i * 8)) & 0xffn))
  }
  return out
}

type Instruction = Parameters<typeof appendTransactionMessageInstruction>[0]

function buildTxBytes(feePayer: string, instruction?: Instruction | Instruction[]): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(toAddress(feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instruction ? Array.isArray(instruction) ? instruction : [instruction] : [], m),
  )
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
}

test('decodes the fee payer from a real compiled transaction', () => {
  expect(decodeTransactionSummary(buildTxBytes(FEE_PAYER))?.feePayer).toBe(FEE_PAYER)
})

test('summarizes a simple SOL transfer amount and recipient', () => {
  const summary = decodeTransactionSummary(
    buildTxBytes(FEE_PAYER, {
      programAddress: toAddress(SYSTEM_PROGRAM),
      accounts: [
        { address: toAddress(FEE_PAYER), role: AccountRole.WRITABLE_SIGNER },
        { address: toAddress(RECIPIENT), role: AccountRole.WRITABLE },
      ],
      data: Uint8Array.from([...u32le(2), ...u64le(250_000_000n)]),
    }),
  )

  expect(summary?.primaryAction).toMatchObject({
    kind: 'sol_transfer',
    label: 'Send SOL',
    amount: '0.25 SOL',
    recipient: RECIPIENT,
    source: FEE_PAYER,
  })
  expect(summary?.instructions[0]).toMatchObject({
    programName: 'System Program',
    instructionName: 'Transfer',
  })
  expect(summary?.estimatedNetworkFee).toBe('0.000005 SOL')
  expect(estimateWalletImpact(summary, FEE_PAYER)).toMatchObject({
    rows: [
      { label: 'Outgoing', value: '-0.25 SOL', tone: 'negative' },
      { label: 'To', value: RECIPIENT, tone: 'neutral' },
      { label: 'Base network fee', value: '-0.000005 SOL', tone: 'negative' },
    ],
    isComplete: true,
    warning: null,
  })
  expect(estimateWalletImpact(summary, RECIPIENT)).toMatchObject({
    rows: [
      { label: 'Incoming', value: '+0.25 SOL', tone: 'positive' },
      { label: 'From', value: FEE_PAYER, tone: 'neutral' },
    ],
    isComplete: true,
    warning: null,
  })
})

test('marks token approval impact as not fully estimated', () => {
  const summary = decodeTransactionSummary(
    buildTxBytes(FEE_PAYER, {
      programAddress: toAddress(TOKEN_PROGRAM),
      accounts: [
        { address: toAddress(FEE_PAYER), role: AccountRole.WRITABLE },
        { address: toAddress(RECIPIENT), role: AccountRole.READONLY },
        { address: toAddress(FEE_PAYER), role: AccountRole.READONLY_SIGNER },
      ],
      data: Uint8Array.from([4, ...u64le(10n)]),
    }),
  )

  expect(summary?.primaryAction.kind).toBe('token_approval')
  expect(summary?.warnings).toContain('This transaction can grant another account token access.')
  expect(estimateWalletImpact(summary, FEE_PAYER)).toMatchObject({
    rows: [
      { label: 'Token access', value: '10 raw token units', tone: 'unknown' },
      { label: 'Token account', value: FEE_PAYER, tone: 'neutral' },
      { label: 'Approved account', value: RECIPIENT, tone: 'neutral' },
      { label: 'Base network fee', value: '-0.000005 SOL', tone: 'negative' },
    ],
    isComplete: false,
    warning: 'This may let another account move tokens.',
  })
})

test('marks unknown transactions as not fully estimated', () => {
  const summary = decodeTransactionSummary(buildTxBytes(FEE_PAYER))

  expect(estimateWalletImpact(summary, FEE_PAYER)).toMatchObject({
    rows: [
      { label: 'Balance changes', value: 'Could not be fully estimated', tone: 'unknown' },
      { label: 'Base network fee', value: '-0.000005 SOL', tone: 'negative' },
    ],
    isComplete: false,
    warning: 'Review the transaction details before signing.',
  })
})

test('returns null on garbage bytes instead of throwing', () => {
  expect(decodeTransactionSummary(Uint8Array.from([1, 2, 3]))).toBeNull()
})

function transfer(lamports: bigint, source = FEE_PAYER, recipient = RECIPIENT): Instruction {
  return {
    programAddress: toAddress(SYSTEM_PROGRAM),
    accounts: [
      { address: toAddress(source), role: AccountRole.WRITABLE_SIGNER },
      { address: toAddress(recipient), role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.from([...u32le(2), ...u64le(lamports)]),
  }
}

const unknownInstruction: Instruction = {
  programAddress: toAddress('BPFLoaderUpgradeab1e11111111111111111111111'),
  data: Uint8Array.from([99]),
}

test('shows both transfers and exact total, rather than presenting the first as the transaction', () => {
  const summary = decodeTransactionSummary(buildTxBytes(FEE_PAYER, [transfer(10_000_000n), transfer(1_500_000_000n)]))
  const impact = estimateWalletImpact(summary, FEE_PAYER)
  expect(impact.rows.filter(row => row.label === 'Outgoing').map(row => row.value)).toEqual(['-0.01 SOL', '-1.5 SOL'])
  expect(impact.rows.filter(row => row.label === 'To')).toHaveLength(2)
  expect(impact.rows).toContainEqual({ label: 'Total outgoing SOL', value: '-1.51 SOL', tone: 'negative' })
  expect(impact.rows.filter(row => row.label === 'Base network fee')).toHaveLength(1)
  expect(impact.isComplete).toBe(true)
  expect(summary?.primaryAction).toMatchObject({ kind: 'program_interaction', amount: null, recipient: null })
  expect(summary?.warnings).toContain('This transaction moves SOL in 2 separate instructions. Review the amounts and addresses shown below.')
  expect(summary?.warnings).not.toContain('This is not a simple transfer.')
})

test.each([true, false])('unknown instructions keep known movements visible and incomplete (unknown first: %s)', (first) => {
  const instructions = first ? [unknownInstruction, transfer(10_000_000n)] : [transfer(10_000_000n), unknownInstruction]
  const summary = decodeTransactionSummary(buildTxBytes(FEE_PAYER, instructions))
  const impact = estimateWalletImpact(summary, FEE_PAYER)
  expect(impact.rows).toContainEqual({ label: 'Outgoing', value: '-0.01 SOL', tone: 'negative' })
  expect(impact.rows.some(row => row.value === 'Effects unknown')).toBe(true)
  expect(impact.isComplete).toBe(false)
  expect(impact.warning).toContain('may not be the full transaction impact')
  expect(summary?.warnings).toContain('The wallet cannot explain every instruction in this transaction. A program may change balances or account control beyond the effects shown here.')
})

test('a known SOL subtotal stays explicitly partial when an unknown program also runs', () => {
  const summary = decodeTransactionSummary(buildTxBytes(FEE_PAYER, [transfer(10_000_000n), transfer(1_500_000_000n), unknownInstruction]))
  const impact = estimateWalletImpact(summary, FEE_PAYER)
  expect(impact.rows).toContainEqual({ label: 'Known outgoing SOL', value: '-1.51 SOL', tone: 'negative' })
  expect(impact.rows.some((row) => row.label === 'Total outgoing SOL')).toBe(false)
  expect(impact.isComplete).toBe(false)
})

test('explains a single unknown program without calling it a transfer', () => {
  const summary = decodeTransactionSummary(buildTxBytes(FEE_PAYER, unknownInstruction))
  expect(summary?.primaryAction.kind).toBe('program_interaction')
  expect(summary?.warnings).toContain('The wallet cannot explain every instruction in this transaction. A program may change balances or account control beyond the effects shown here.')
  expect(summary?.warnings).not.toContain('This is not a simple transfer.')
})

test('keeps incoming and outgoing totals separate and treats self-transfers as neutral', () => {
  const impact = estimateWalletImpact(decodeTransactionSummary(buildTxBytes(FEE_PAYER, [
    transfer(10n), transfer(20n, RECIPIENT, FEE_PAYER), transfer(30n, FEE_PAYER, FEE_PAYER),
  ])), FEE_PAYER)
  expect(impact.rows).toContainEqual({ label: 'Total outgoing SOL', value: '-0.00000001 SOL', tone: 'negative' })
  expect(impact.rows).toContainEqual({ label: 'Total incoming SOL', value: '+0.00000002 SOL', tone: 'positive' })
  expect(impact.rows).toContainEqual({ label: 'Self-transfer', value: '0.00000003 SOL (no net SOL movement)', tone: 'neutral' })
  expect(impact.isComplete).toBe(true)
})

test('retains lamport precision beyond Number.MAX_SAFE_INTEGER', () => {
  const impact = estimateWalletImpact(decodeTransactionSummary(buildTxBytes(FEE_PAYER, [transfer(9_007_199_254_740_993n), transfer(1n)])), FEE_PAYER)
  expect(impact.rows).toContainEqual({ label: 'Total outgoing SOL', value: '-9007199.254740994 SOL', tone: 'negative' })
})

test('does not charge the selected wallet for another fee payer or unrelated transfers', () => {
  const impact = estimateWalletImpact(decodeTransactionSummary(buildTxBytes(RECIPIENT, transfer(10n))), SYSTEM_PROGRAM)
  expect(impact.rows.some(row => row.label === 'Base network fee' || row.label === 'Outgoing')).toBe(false)
  expect(impact.rows).toContainEqual({ label: 'Other SOL transfer', value: '0.00000001 SOL', tone: 'neutral' })
})

test.each([true, false])('shows authority changes after a transfer, decoding new authority from data (removed: %s)', (removed) => {
  const authority: Instruction = {
    programAddress: toAddress(TOKEN_PROGRAM),
    accounts: [
      { address: toAddress(FEE_PAYER), role: AccountRole.WRITABLE },
      { address: toAddress(FEE_PAYER), role: AccountRole.READONLY_SIGNER },
    ],
    data: Uint8Array.from([6, 3, removed ? 0 : 1, ...(removed ? [] : getAddressEncoder().encode(toAddress(RECIPIENT)))]),
  }
  const summary = decodeTransactionSummary(buildTxBytes(FEE_PAYER, [transfer(10n), authority]))
  const impact = estimateWalletImpact(summary, FEE_PAYER)
  expect(impact.rows).toContainEqual({ label: 'Authority change', value: 'Change token close authority', tone: 'unknown' })
  expect(impact.rows).toContainEqual({ label: 'New authority', value: removed ? 'Authority removed' : RECIPIENT, tone: 'neutral' })
  expect(impact.isComplete).toBe(false)
  expect(summary?.warnings).toContain('This transaction can change token authority.')
})

test.each([
  { ...transfer(10n), data: Uint8Array.from(u32le(2)) },
  { ...transfer(10n), accounts: [] },
  { programAddress: toAddress(TOKEN_PROGRAM), data: Uint8Array.from([6, 3, 1]) },
])('retains malformed instruction uncertainty alongside a valid transfer', (malformed) => {
  const impact = estimateWalletImpact(decodeTransactionSummary(buildTxBytes(FEE_PAYER, [transfer(10n), malformed])), FEE_PAYER)
  expect(impact.rows.some(row => row.label === 'Outgoing')).toBe(true)
  expect(impact.rows.some(row => row.value === 'Effects unknown')).toBe(true)
  expect(impact.isComplete).toBe(false)
})

test('unresolved lookup accounts cannot masquerade as a fully understood transfer', () => {
  const impact = estimateWalletImpact(decodeTransactionSummary(buildTxBytes(FEE_PAYER, {
    ...transfer(10n),
    accounts: [
      { address: toAddress(FEE_PAYER), role: AccountRole.WRITABLE_SIGNER },
      { address: toAddress(RECIPIENT), role: AccountRole.WRITABLE, addressIndex: 0, lookupTableAddress: toAddress(TOKEN_PROGRAM) },
    ],
  })), FEE_PAYER)
  expect(impact.isComplete).toBe(false)
  expect(impact.rows.some(row => row.label === 'Outgoing')).toBe(false)
})

test.each([TOKEN_PROGRAM, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'])('does not infer token-account ownership from a wallet address for %s', (program) => {
  const impact = estimateWalletImpact(decodeTransactionSummary(buildTxBytes(FEE_PAYER, {
    ...transfer(10n), programAddress: toAddress(program), data: Uint8Array.from([3, ...u64le(10n)]),
    accounts: [
      { address: toAddress(FEE_PAYER), role: AccountRole.WRITABLE },
      { address: toAddress(RECIPIENT), role: AccountRole.WRITABLE },
      { address: toAddress(FEE_PAYER), role: AccountRole.READONLY_SIGNER },
    ],
  })), FEE_PAYER)
  expect(impact.isComplete).toBe(false)
  expect(impact.rows).toContainEqual({ label: 'Token movement', value: '10 raw token units', tone: 'unknown' })
})

test.each([0n, 1000n])('does not silently omit a nonzero priority fee (%s micro-lamports)', (price) => {
  const impact = estimateWalletImpact(decodeTransactionSummary(buildTxBytes(FEE_PAYER, [transfer(10n), {
    programAddress: toAddress('ComputeBudget111111111111111111111111111111'),
    data: Uint8Array.from([3, ...u64le(price)]),
  }])), FEE_PAYER)
  expect(impact.isComplete).toBe(price === 0n)
  expect(impact.rows.some(row => row.label === 'Base network fee')).toBe(true)
})

test('includes account funding alongside transfers in composed SOL totals', () => {
  const creation: Instruction = {
    ...transfer(1_500_000_000n),
    data: Uint8Array.from([...u32le(0), ...u64le(1_500_000_000n), ...u64le(82n), ...getAddressEncoder().encode(toAddress(TOKEN_PROGRAM))]),
  }
  const summary = decodeTransactionSummary(buildTxBytes(FEE_PAYER, [transfer(10_000_000n), creation]))
  const impact = estimateWalletImpact(summary, FEE_PAYER)
  expect(impact.rows).toContainEqual({ label: 'New account funding', value: '-1.5 SOL', tone: 'negative' })
  expect(impact.rows).toContainEqual({ label: 'Total outgoing SOL', value: '-1.51 SOL', tone: 'negative' })
  expect(summary?.instructions[1]?.effect.status).toBe('understood')
})

test('recognizes minting without claiming wallet token ownership or complete balances', () => {
  const summary = decodeTransactionSummary(buildTxBytes(FEE_PAYER, {
    programAddress: toAddress(TOKEN_PROGRAM),
    accounts: [
      { address: toAddress(RECIPIENT), role: AccountRole.WRITABLE },
      { address: toAddress(SYSTEM_PROGRAM), role: AccountRole.WRITABLE },
      { address: toAddress(FEE_PAYER), role: AccountRole.READONLY_SIGNER },
    ],
    data: Uint8Array.from([14, ...u64le(123_000_000n), 6]),
  }))
  expect(summary?.primaryAction).toMatchObject({ kind: 'token_mint', amount: '123 tokens' })
  expect(estimateWalletImpact(summary, FEE_PAYER).isComplete).toBe(false)
})
