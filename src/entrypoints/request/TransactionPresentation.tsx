import type { ApprovalPresentation } from '../../signing/approval-presentation.ts'
import { formatSol } from '../../signing/approval-presentation.ts'

export function TransactionRecipients({ view }: { view: ApprovalPresentation }) {
  return <div className="ec-approval-recipients" data-testid="transaction-recipients">
    <p className="ec-help">{view.subtitle}</p>
    {view.recipients.map(recipient => <details key={`${recipient.address}:${recipient.purpose}`}>
      <summary>
        <span className="ec-recipient-address">{recipient.address.slice(0, 8)}…{recipient.address.slice(-6)}</span>
        <span>{formatSol(recipient.lamports)}{recipient.purpose === 'account_creation' ? ' · funding' : ''}</span>
      </summary>
      <p className="ec-full-address">{recipient.address}</p>
    </details>)}
  </div>
}

export function TransactionAmounts({ view }: { view: ApprovalPresentation }) {
  return <section className="ec-approval-amounts" data-testid="estimated-changes" aria-label="Estimated balance changes">
    <p className="ec-amount-label">{view.headline.label}</p>
    <p className="ec-amount-total" data-testid="sol-total" data-tone={view.headline.tone}>{view.headline.value}</p>
    <p className="ec-amount-note">{view.note}</p>
    {view.breakdown.length > 0 ? <dl>
      {view.breakdown.map((row, i) => <div key={`${i}:${row.label}`} data-tone={row.tone}>
        <dt>{row.label}</dt><dd>{row.value}</dd>
      </div>)}
    </dl> : null}
  </section>
}

export function TransactionWarnings({ view }: { view: ApprovalPresentation }) {
  if (!view.warning && view.actions.length === 0) return null
  return <section className="ec-approval-warning" data-testid="impact-warning" aria-label="Transaction effects to review">
    {view.actions.map((action, i) => <div key={i}>
      <strong>{action.label}{action.amount ? ` · ${action.amount}` : ''}</strong>
      {action.source ? <p>Affected account: <span className="ec-full-address">{action.source}</span></p> : null}
      {action.recipient ? <p>{action.kind === 'authority_change' ? 'New authority' : action.kind === 'token_approval' ? 'Account receiving access' : 'Destination'}: <span className="ec-full-address">{action.recipient}</span></p> : null}
    </div>)}
    {view.warning ? <p>{view.warning}</p> : null}
  </section>
}
