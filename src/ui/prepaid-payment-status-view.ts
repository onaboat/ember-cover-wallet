import type { LocalPrepaidPaymentState } from '../background/prepaid-payment-service.ts'
import type { WalletCluster } from '../background/wallet-data-config.ts'
import type { CoverStatusSnapshot } from '../cover/ember-types.ts'

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
  primaryAction: 'activate' | 'manage' | 'sync'
  title: string
}

export interface PaymentStatusInput {
  cluster: WalletCluster
  coverEnrolled: boolean | null
  coverStatusLoading: boolean
  coverStatusSnapshot: CoverStatusSnapshot | null
  paymentState: LocalPrepaidPaymentState | null
}

function clusterLabel(cluster: WalletCluster): string {
  return cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'
}

function money(value: number): string {
  return `$${value.toLocaleString()}`
}

function stateMetrics(state: LocalPrepaidPaymentState): PaymentStatusMetric[] {
  return [
    { label: 'Plan', value: state.tier },
    { label: 'Network', value: clusterLabel(state.cluster) },
    { label: 'Payment', value: state.status === 'active' ? 'Confirmed' : 'Pending' },
  ]
}

export function prepaidPaymentStatusView(input: PaymentStatusInput): PaymentStatusView {
  const { cluster, coverEnrolled, coverStatusLoading, coverStatusSnapshot, paymentState } = input
  if (coverStatusLoading) {
    return {
      badgeLabel: 'CHECKING',
      badgeTone: 'checking',
      detail: 'Checking Ember Cover status.',
      metrics: paymentState ? stateMetrics(paymentState) : [],
      primaryAction: paymentState?.paymentSignature ? 'sync' : 'activate',
      title: 'Coverage',
    }
  }

  if (paymentState && paymentState.cluster !== cluster) {
    return {
      badgeLabel: 'NETWORK',
      badgeTone: 'pending',
      detail: `This payment is for ${clusterLabel(paymentState.cluster)}. Current wallet network is ${clusterLabel(cluster)}.`,
      metrics: stateMetrics(paymentState),
      primaryAction: 'manage',
      title: 'Coverage',
    }
  }

  if (coverStatusSnapshot?.subscriptionActive && coverStatusSnapshot.walletRegistered) {
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

  if (paymentState) {
    if (
      paymentState.status === 'broadcast_pending' ||
      paymentState.status === 'confirmation_pending' ||
      paymentState.status === 'activation_pending'
    ) {
      return {
        badgeLabel: 'PENDING',
        badgeTone: 'pending',
        detail: 'Your one-off payment is recorded. Retry activation without paying again.',
        metrics: stateMetrics(paymentState),
        primaryAction: 'sync',
        title: 'Coverage',
      }
    }
    if (paymentState.status === 'failed_recoverable') {
      return {
        badgeLabel: 'RETRY',
        badgeTone: 'failed',
        detail: 'The saved payment needs attention. Retry it without approving another payment.',
        metrics: stateMetrics(paymentState),
        primaryAction: 'sync',
        title: 'Coverage',
      }
    }
    return {
      badgeLabel: 'UNAVAILABLE',
      badgeTone: 'unavailable',
      detail: 'Payment activation is saved, but live cover status could not be verified.',
      metrics: stateMetrics(paymentState),
      primaryAction: 'sync',
      title: 'Coverage',
    }
  }

  if (coverEnrolled) {
    return {
      badgeLabel: 'UNAVAILABLE',
      badgeTone: 'unavailable',
      detail: 'Cover authorization exists, but no active payment could be verified.',
      metrics: [],
      primaryAction: 'activate',
      title: 'Coverage',
    }
  }

  return {
    badgeLabel: 'NO COVER',
    badgeTone: 'none',
    detail: 'Make a one-off USDC payment to activate 30 days of Ember Cover.',
    metrics: [],
    primaryAction: 'activate',
    title: 'Coverage',
  }
}
