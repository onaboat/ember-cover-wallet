import type { LocalCoveragePaymentState } from '../background/coverage-payment-service.ts'
import type { WalletCluster } from '../background/wallet-data-config.ts'
import type { CoverStatusSnapshot } from '../cover/ember-types.ts'
import { coverPeriodExpired, coverStatusActive } from '../cover/ember-types.ts'

export type PaymentBadgeTone =
  | 'checking'
  | 'failed'
  | 'none'
  | 'pending'
  | 'protected'
  | 'unavailable'

export interface PaymentStatusMetric {
  label: string
  value: string
}

export interface PaymentStatusView {
  badgeLabel: string
  badgeTone: PaymentBadgeTone
  detail: string
  metrics: PaymentStatusMetric[]
  primaryAction: 'activate' | 'connect' | 'manage' | 'refresh' | 'review' | 'sync'
  title: string
}

export interface PaymentStatusInput {
  cluster: WalletCluster
  coverEnrolled: boolean | null
  coverStatusLoading: boolean
  coverStatusSnapshot: CoverStatusSnapshot | null
  nowMs?: number
  paymentState: LocalCoveragePaymentState | null
}

function clusterLabel(cluster: WalletCluster): string {
  return cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'
}

function money(value: number): string {
  return `$${value.toLocaleString()}`
}

function paymentLabel(status: LocalCoveragePaymentState['status']): string {
  switch (status) {
    case 'quote_ready':
      return 'Not submitted'
    case 'broadcast_pending':
    case 'activation_pending':
      return 'Pending'
    case 'active':
      return 'Confirmed'
    case 'rejected':
      return 'Failed'
    case 'failed_recoverable':
      return 'Needs attention'
    case 'expired_unconfirmed':
      return 'Not sent'
  }
}

function stateMetrics(state: LocalCoveragePaymentState): PaymentStatusMetric[] {
  return [
    { label: 'Plan', value: state.offer.displayName },
    { label: 'Network', value: clusterLabel(state.cluster) },
    { label: 'Payment', value: paymentLabel(state.status) },
  ]
}

export function coveragePaymentStatusView(input: PaymentStatusInput): PaymentStatusView {
  const {
    cluster,
    coverEnrolled,
    coverStatusLoading,
    coverStatusSnapshot,
    nowMs = Date.now(),
    paymentState,
  } = input
  const submittedPaymentState = paymentState?.paymentSignature ? paymentState : null
  if (coverStatusLoading) {
    return {
      badgeLabel: 'CHECKING',
      badgeTone: 'checking',
      detail: 'Checking Ember Cover status.',
      metrics: submittedPaymentState ? stateMetrics(submittedPaymentState) : [],
      primaryAction: submittedPaymentState ? 'sync' : coverEnrolled ? 'activate' : 'connect',
      title: 'Coverage',
    }
  }

  if (submittedPaymentState && submittedPaymentState.cluster !== cluster) {
    return {
      badgeLabel: 'NETWORK',
      badgeTone: 'pending',
      detail: `This payment is for ${clusterLabel(submittedPaymentState.cluster)}. Current wallet network is ${clusterLabel(cluster)}.`,
      metrics: stateMetrics(submittedPaymentState),
      primaryAction: 'manage',
      title: 'Coverage',
    }
  }

  if (coverStatusSnapshot && coverStatusActive(coverStatusSnapshot, nowMs)) {
    return {
      badgeLabel: 'PROTECTED',
      badgeTone: 'protected',
      detail: 'Ember Cover is active for this wallet.',
      metrics: [
        { label: 'Plan', value: coverStatusSnapshot.tier },
        {
          label: 'Checks',
          value: `${coverStatusSnapshot.remainingCoveredTxThisMonth} of ${coverStatusSnapshot.coveredTxPerMonth}`,
        },
        {
          label: 'Loss cap',
          value: `${money(coverStatusSnapshot.remainingLossCapUsd)} of ${money(coverStatusSnapshot.monthlyLossCapUsd)}`,
        },
      ],
      primaryAction: 'manage',
      title: 'Coverage',
    }
  }

  if (submittedPaymentState) {
    if (
      submittedPaymentState.status === 'broadcast_pending' ||
      submittedPaymentState.status === 'activation_pending'
    ) {
      return {
        badgeLabel: 'PENDING',
        badgeTone: 'pending',
        detail: 'Your quote-bound payment is recorded. Retry without signing another payment.',
        metrics: stateMetrics(submittedPaymentState),
        primaryAction: 'sync',
        title: 'Coverage',
      }
    }
    if (submittedPaymentState.status === 'failed_recoverable') {
      return {
        badgeLabel: 'RETRY',
        badgeTone: 'failed',
        detail: 'The signed payment needs attention. Recover it without approving another payment.',
        metrics: stateMetrics(submittedPaymentState),
        primaryAction: 'sync',
        title: 'Coverage',
      }
    }
    if (submittedPaymentState.status === 'expired_unconfirmed') {
      return {
        badgeLabel: 'NOT SENT',
        badgeTone: 'none',
        detail: 'The prior transaction can no longer land. Review a new server-signed quote.',
        metrics: stateMetrics(submittedPaymentState),
        primaryAction: 'activate',
        title: 'Coverage',
      }
    }
    if (submittedPaymentState.status === 'rejected') {
      return {
        badgeLabel: 'FAILED',
        badgeTone: 'failed',
        detail: 'The payment failed on-chain. No cover was activated.',
        metrics: stateMetrics(submittedPaymentState),
        primaryAction: 'activate',
        title: 'Coverage',
      }
    }
  }

  if (coverStatusSnapshot && coverPeriodExpired(coverStatusSnapshot, nowMs)) {
    return {
      badgeLabel: 'EXPIRED',
      badgeTone: 'none',
      detail: 'This coverage period has ended. Review a current offer and signed quote to renew.',
      metrics: submittedPaymentState ? stateMetrics(submittedPaymentState) : [],
      primaryAction: 'activate',
      title: 'Coverage',
    }
  }

  if (coverStatusSnapshot && !coverStatusSnapshot.subscriptionActive) {
    return {
      badgeLabel: 'NO COVER',
      badgeTone: 'none',
      detail: 'Ember Cover is not active for this wallet.',
      metrics: submittedPaymentState ? stateMetrics(submittedPaymentState) : [],
      primaryAction: 'activate',
      title: 'Coverage',
    }
  }

  if (submittedPaymentState) {
    return {
      badgeLabel: 'UNAVAILABLE',
      badgeTone: 'unavailable',
      detail: 'Payment history is saved, but live cover status could not be verified.',
      metrics: stateMetrics(submittedPaymentState),
      primaryAction: 'refresh',
      title: 'Coverage',
    }
  }

  if (coverEnrolled) {
    return {
      badgeLabel: 'NO COVER',
      badgeTone: 'none',
      detail: 'Review your Ember Cover offer.',
      metrics: [],
      primaryAction: 'activate',
      title: 'Coverage',
    }
  }

  return {
    badgeLabel: 'NO COVER',
    badgeTone: 'none',
    detail: 'View your Ember Cover offer.',
    metrics: [],
    primaryAction: 'connect',
    title: 'Coverage',
  }
}
