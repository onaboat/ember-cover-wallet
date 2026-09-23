import { expect, test } from 'vitest'
import { approvalPresentation } from './approval-presentation.ts'
import type { TxInstructionSummary, TxPrimaryAction, TxSummary } from './transaction-summary.ts'

const wallet = 'wallet'
function transfer(amount: bigint, recipient = 'recipient', source = wallet): TxPrimaryAction {
  return { kind: 'sol_transfer', label: 'Send SOL', amount: 'fixture amount', lamports: amount, source, recipient, tokenMint: null }
}
function summary(actions: TxPrimaryAction[], unknown = false, feePayer = wallet): TxSummary {
  const instructions: TxInstructionSummary[] = actions.map(action => ({ program: 'program', programName: 'System Program', accounts: [], instructionName: 'Transfer', effect: { status: 'understood', action } }))
  if (unknown) instructions.push({ program: 'unknown', programName: 'Program', instructionName: null, accounts: [], effect: { status: 'unknown' } })
  return { feePayer, baseNetworkFeeLamports: 5000n, estimatedNetworkFee: '0.000005 SOL', instructions, warnings: [], signingBlock: null,
    primaryAction: actions[0] ?? { kind: 'unknown', label: 'Review transaction', amount: null, source: null, recipient: null, tokenMint: null } }
}

test('total includes every outgoing transfer and the fee once', () => {
  const view = approvalPresentation(summary([transfer(10_000_000n), transfer(1_500_000_000n, 'second')]), wallet)
  expect(view.headline).toMatchObject({ label: 'Total SOL leaving · estimated', value: '-1.510005 SOL' })
  expect(view.recipients).toHaveLength(2)
  expect(view.subtitle).toBe('Send to 2 recipients')
})
test('multiple transfers to the same destination display one recipient with the combined amount', () => {
  const view = approvalPresentation(summary([transfer(10_000_000n), transfer(20_000_000n)]), wallet)
  expect(view.recipients).toEqual([{ address: 'recipient', lamports: 30_000_000n, purpose: 'transfer' }])
  expect(view.subtitle).toBe('Send to one recipient')
})
test('does not treat a self-transfer or another account’s transfer as outgoing', () => {
  const view = approvalPresentation(summary([transfer(100n, wallet), transfer(200n, 'other', 'third')]), wallet)
  expect(view.headline.value).toBe('-0.000005 SOL')
  expect(view.recipients).toEqual([])
})
test('sponsored outgoing transfers do not charge this wallet a fee', () => {
  const view = approvalPresentation(summary([transfer(10_000_000n)], false, 'sponsor'), wallet)
  expect(view.headline.value).toBe('-0.01 SOL')
  expect(view.breakdown).toContainEqual({ label: 'Network fee', value: 'Paid by another account', tone: 'neutral' })
})
test('funding a new account is included and labelled separately from a payment', () => {
  const action: TxPrimaryAction = { kind: 'account_creation', label: 'Fund account', amount: '0.002 SOL', lamports: 2_000_000n, source: wallet, recipient: 'new-account', tokenMint: null }
  const view = approvalPresentation(summary([transfer(10_000_000n), action]), wallet)
  expect(view.headline.value).toBe('-0.012005 SOL')
  expect(view.breakdown).toContainEqual({ label: 'New account funding', value: '-0.002 SOL', tone: 'negative' })
})
test('incoming and outgoing SOL use a net label without concealing the outgoing breakdown', () => {
  const view = approvalPresentation(summary([transfer(1_000_000_000n), transfer(2_000_000_000n, wallet, 'sender')]), wallet)
  expect(view.headline).toMatchObject({ label: 'Net SOL change · estimated', value: '+0.999995 SOL' })
  expect(view.breakdown).toContainEqual({ label: 'SOL sent', value: '-1 SOL', tone: 'negative' })
})
test('partial instructions never present the known amount as the full cost', () => {
  const view = approvalPresentation(summary([transfer(10_000_000n)], true), wallet)
  expect(view.headline.label).toBe('Known SOL leaving')
  expect(view.warning).toContain('Some instruction effects')
  expect(view.note).toContain('may not be the full cost')
})
test('a fee alone does not stand in for unknown balance changes', () => {
  expect(approvalPresentation(summary([], true), wallet).headline.value).toBe('Not available')
})
test('simulation includes fees already and must not be added to decoded transfers', () => {
  const view = approvalPresentation(summary([transfer(10_000_000n)], true), wallet, { contextSlot: '100', solBalanceBefore: '3000000000', solBalanceAfter: '998771920', tokenBalances: [] })
  expect(view.headline).toMatchObject({ label: 'Net SOL change · simulated', value: '-2.00122808 SOL' })
  expect(view.breakdown).toEqual([{ label: 'Base fee estimate · already included', value: '0.000005 SOL', tone: 'neutral' }])
})
test('simulation and formatting preserve one lamport above Number safe range', () => {
  const view = approvalPresentation(summary([], true), wallet, { contextSlot: '100', solBalanceBefore: '9007199254740993', solBalanceAfter: '9007199254740992', tokenBalances: [] })
  expect(view.headline.value).toBe('-0.000000001 SOL')
})
test('sponsored simulation does not attribute the sponsor’s fee to this wallet', () => {
  const view = approvalPresentation(summary([transfer(10_000_000n)], false, 'sponsor'), wallet, { contextSlot: '100', solBalanceBefore: '20000000', solBalanceAfter: '10000000', tokenBalances: [] })
  expect(view.headline.value).toBe('-0.01 SOL')
  expect(view.note).toContain('network fee is paid by another account')
  expect(view.breakdown).toEqual([])
})
test('malformed simulation cannot replace a valid decoded estimate', () => {
  const view = approvalPresentation(summary([transfer(10_000_000n)]), wallet, { contextSlot: '100', solBalanceBefore: '1e9', solBalanceAfter: '0', tokenBalances: [] })
  expect(view.source).toBe('decoded')
  expect(view.headline.value).toBe('-0.010005 SOL')
})
test('sponsored token observations retain raw units without inventing ownership or decimals', () => {
  const view = approvalPresentation(summary([], true, 'sponsor'), wallet, { contextSlot: '100', tokenBalances: [{ account: 'account', mint: 'mint', preAmount: '10', postAmount: '0' }] })
  expect(view.headline.value).toBe('Not available')
  expect(view.breakdown).toContainEqual({ label: 'Token mint', value: '-10 raw token units', tone: 'negative' })
})
