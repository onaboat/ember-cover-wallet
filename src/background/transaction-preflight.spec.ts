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

test.each(['approve', 'approveChecked'])('blocks a successful simulation with an inner %s granting unlimited access', async (type) => {
  const result = await preflightTransaction(transaction(0), 'devnet', async () => ({ err: null, innerInstructions: [{ index: 0, instructions: [{
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    parsed: { type, info: { amount: '18446744073709551615', tokenAmount: { amount: '18446744073709551615' } } },
  }] }] }))
  expect(result).toMatchObject({ status: 'blocked', reason: 'dangerous_effects' })
})

test('blocks an inner authority handover even when token balances do not change', async () => {
  const result = await preflightTransaction(transaction(0), 'devnet', async () => ({ err: null, innerInstructions: [{ instructions: [{
    programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    parsed: { type: 'setAuthority', info: { authorityType: 'permanentDelegate', authority: 'So11111111111111111111111111111111111111112', newAuthority: '11111111111111111111111111111111' } },
  }] }] }))
  expect(result).toMatchObject({ status: 'blocked', reason: 'dangerous_effects' })
})

test('does not trust a custom program claiming to be a parsed token approval', async () => {
  expect(await preflightTransaction(transaction(0), 'devnet', async () => ({ err: null, innerInstructions: [{ instructions: [{
    programId: '11111111111111111111111111111111', parsed: { type: 'approve', info: { amount: '18446744073709551615' } },
  }] }] }))).toEqual({ status: 'valid' })
})
