import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TransactionAmounts } from '../../src/entrypoints/request/TransactionPresentation.tsx'
import type { ApprovalPresentation } from '../../src/signing/approval-presentation.ts'
import { simulatedWalletImpact } from '../../src/signing/simulation-effects.ts'

const mint = 'C21EF5tdZJnsb8x7qpMZKg8A3gPLiVgseK1SxpsyxJNb'
const account = 'Fqyw4PnWRYk8QMdYmTLeUJnhMJPQTTZGK7BN3TUYkAzM'
const impact = simulatedWalletImpact({ contextSlot: '502802616', tokenBalances: [
  { account, mint, preAmount: '0', postAmount: '5000000' },
] })!
const view: ApprovalPresentation = {
  title: 'Review transaction', subtitle: '', recipients: [], actions: [], warning: null, source: 'simulated',
  headline: { label: 'Net SOL change · simulated', value: '-0.00296004 SOL', tone: 'negative' },
  note: 'Includes the network fee. This is a net change, not a spending limit.',
  breakdown: [{ label: 'Base fee estimate · already included', value: '0.00001 SOL', tone: 'neutral' }, ...impact.rows],
}

const tone = process.argv[2] === 'covered' ? 'covered' : 'none'
process.stdout.write(renderToStaticMarkup(createElement('main', { className: 'ec-task-screen ec-approval-screen', style: { padding: 16 } },
  createElement('section', { className: 'ec-review-card ec-cover-decision', 'data-tone': tone },
    createElement('strong', { className: 'ec-cover-callout-title' }, tone === 'covered' ? 'Covered' : 'Not covered'),
    createElement(TransactionAmounts, { view })))))
