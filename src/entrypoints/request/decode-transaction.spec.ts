import {
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

import { decodeTransactionSummary } from './decode-transaction.ts'

const FEE_PAYER = 'So11111111111111111111111111111111111111112'

function buildTxBytes(feePayer: string): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(toAddress(feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n },
        m,
      ),
  )
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
}

test('decodes the fee payer from a real compiled transaction', () => {
  expect(decodeTransactionSummary(buildTxBytes(FEE_PAYER))?.feePayer).toBe(FEE_PAYER)
})

test('returns null on garbage bytes instead of throwing', () => {
  expect(decodeTransactionSummary(Uint8Array.from([1, 2, 3]))).toBeNull()
})
