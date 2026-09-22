import { expect, test, vi } from 'vitest'
import { address, blockhash, compileTransaction, createTransactionMessage, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit'
import { preflightTransaction } from './transaction-preflight.ts'

function transaction(version: 0 | 'legacy') {
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(address('So11111111111111111111111111111111111111112'), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, m),
  ))))
}

test.each([0, 'legacy'] as const)('validates exact %s transaction bytes', async (version) => {
  const bytes = transaction(version)
  const simulate = vi.fn(async () => ({ err: null }))
  expect(await preflightTransaction(bytes, 'devnet', simulate)).toEqual({ status: 'valid' })
  expect(simulate).toHaveBeenCalledWith(Buffer.from(bytes).toString('base64'), 'devnet')
})

test('expired transaction directs the user to request fresh bytes from the dapp', async () => {
  expect(await preflightTransaction(transaction(0), 'devnet', async () => ({ err: 'BlockhashNotFound' })))
    .toMatchObject({ status: 'blocked', reason: 'expired', message: expect.stringContaining('start a new request') })
})

test('simulation failure retains instruction error and runtime logs for diagnosis', async () => {
  const result = await preflightTransaction(transaction(0), 'devnet', async () => ({ err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports'] }))
  expect(result).toMatchObject({ status: 'blocked', reason: 'simulation_failed', details: expect.stringContaining('insufficient lamports') })
})

test('RPC failure is distinct from failed simulation and exposes no endpoint', async () => {
  expect(await preflightTransaction(transaction(0), 'devnet', async () => { throw new Error('secret endpoint') }))
    .toMatchObject({ status: 'blocked', reason: 'rpc_unavailable' })
})
