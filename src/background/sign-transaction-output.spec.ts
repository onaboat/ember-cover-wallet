import {
  address as toAddress,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { expect, test } from 'vitest'

import { buildConnectAccount } from './build-account.ts'
import { buildSignTransactionOutputs } from './sign-transaction-output.ts'

const FEE_PAYER = 'So11111111111111111111111111111111111111112'
const ACCOUNT = buildConnectAccount(FEE_PAYER)
const OTHER_ACCOUNT = buildConnectAccount('11111111111111111111111111111112')

function dummyTxBytes(): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(toAddress(FEE_PAYER), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n },
        m,
      ),
  )
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
}

test('places the vault signature into the transaction signatures map', async () => {
  const out = await buildSignTransactionOutputs(
    [{ account: ACCOUNT, transaction: dummyTxBytes() }],
    async () => new Uint8Array(64).fill(9),
    FEE_PAYER,
  )
  const decoded = getTransactionDecoder().decode(out[0]!.signedTransaction as Uint8Array)
  expect(Array.from((decoded.signatures[toAddress(FEE_PAYER)] ?? new Uint8Array()) as Uint8Array)).toEqual(
    Array(64).fill(9),
  )
})

test('rejects a transaction request for another account', async () => {
  await expect(
    buildSignTransactionOutputs(
      [{ account: OTHER_ACCOUNT, transaction: dummyTxBytes() }],
      async () => new Uint8Array(64),
      FEE_PAYER,
    ),
  ).rejects.toThrow('Account does not match vault')
})
