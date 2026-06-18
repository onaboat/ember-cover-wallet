import {
  AccountRole,
  appendTransactionMessageInstruction,
  address as toAddress,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
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

function buildTxBytes(feePayer: string, instruction?: Parameters<typeof appendTransactionMessageInstruction>[0]): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(toAddress(feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n },
        m,
      ),
    (m) => instruction ? appendTransactionMessageInstruction(instruction, m) : m,
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
      { label: 'You send', value: '-0.25 SOL', tone: 'negative' },
      { label: 'To', value: '11111111...111112', tone: 'neutral' },
      { label: 'Network fee', value: '-0.000005 SOL', tone: 'negative' },
    ],
    isComplete: true,
    warning: null,
  })
  expect(estimateWalletImpact(summary, RECIPIENT)).toMatchObject({
    rows: [
      { label: 'You receive', value: '+0.25 SOL', tone: 'positive' },
      { label: 'From', value: 'So111111...111112', tone: 'neutral' },
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
      { label: 'Approved account', value: '11111111...111112', tone: 'neutral' },
      { label: 'Network fee', value: '-0.000005 SOL', tone: 'negative' },
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
      { label: 'Network fee', value: '-0.000005 SOL', tone: 'negative' },
    ],
    isComplete: false,
    warning: 'Review the transaction details before signing.',
  })
})

test('returns null on garbage bytes instead of throwing', () => {
  expect(decodeTransactionSummary(Uint8Array.from([1, 2, 3]))).toBeNull()
})
