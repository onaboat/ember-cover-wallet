import type { LocalSubscriptionState } from '../background/subscription-service.ts'
import type { WalletCluster } from '../background/wallet-data-config.ts'
import type { CoverStatusSnapshot } from '../cover/ember-types.ts'

export type SubscriptionBadgeTone =
  | 'checking'
  | 'failed'
  | 'none'
  | 'pending'
  | 'protected'
  | 'setup'
  | 'unavailable'

export interface SubscriptionStatusMetric {
  label: string
  value: string
}

export interface SubscriptionStatusView {
  badgeLabel: string
  badgeTone: SubscriptionBadgeTone
  detail: string
  metrics: SubscriptionStatusMetric[]
  primaryAction: 'activate' | 'manage' | 'sync'
  title: string
}

export interface SubscriptionStatusInput {
  cluster: WalletCluster
  coverEnrolled: boolean | null
  coverStatusLoading: boolean
  coverStatusSnapshot: CoverStatusSnapshot | null
  subscriptionState: LocalSubscriptionState | null
}

function clusterLabel(cluster: WalletCluster): string {
  return cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'
}

function statusLabel(status: LocalSubscriptionState['status']): string {
  switch (status) {
    case 'active':
      return 'Active'
    case 'api_registration_pending':
      return 'API entitlement pending'
    case 'canceled':
      return 'Canceled'
    case 'failed':
      return 'Failed'
    case 'pending':
      return 'Pending'
    case 'revoked':
      return 'Revoked'
    case 'setup_confirmed':
      return 'USDC setup confirmed'
  }
}

function money(value: number): string {
  return `$${value.toLocaleString()}`
}

function stateMetrics(state: LocalSubscriptionState): SubscriptionStatusMetric[] {
  return [
    { label: 'Plan', value: state.planId.toUpperCase() },
    { label: 'Network', value: clusterLabel(state.cluster) },
    { label: 'API', value: state.registeredWithApi ? 'Registered' : 'Pending' },
  ]
}

export function subscriptionStatusView(input: SubscriptionStatusInput): SubscriptionStatusView {
  const { cluster, coverEnrolled, coverStatusLoading, coverStatusSnapshot, subscriptionState } = input
  if (coverStatusLoading) {
    return {
      badgeLabel: 'CHECKING',
      badgeTone: 'checking',
      detail: 'Checking subscription status.',
      metrics: subscriptionState ? stateMetrics(subscriptionState) : [],
      primaryAction: subscriptionState?.subscriptionSignature ? 'sync' : 'activate',
      title: 'Coverage',
    }
  }

  if (subscriptionState && subscriptionState.cluster !== cluster) {
    return {
      badgeLabel: 'NETWORK',
      badgeTone: 'pending',
      detail: `Subscription is for ${clusterLabel(subscriptionState.cluster)}. Current wallet network is ${clusterLabel(cluster)}.`,
      metrics: stateMetrics(subscriptionState),
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

  if (subscriptionState) {
    if (subscriptionState.status === 'setup_confirmed') {
      return {
        badgeLabel: 'SETUP',
        badgeTone: 'setup',
        detail: 'USDC setup is confirmed. Review and approve the subscription to start cover.',
        metrics: stateMetrics(subscriptionState),
        primaryAction: 'activate',
        title: 'Coverage',
      }
    }

    if (subscriptionState.status === 'api_registration_pending' || subscriptionState.status === 'pending') {
      return {
        badgeLabel: 'PENDING',
        badgeTone: 'pending',
        detail: 'Subscription is approved. Sync entitlement to activate cover decisions.',
        metrics: stateMetrics(subscriptionState),
        primaryAction: subscriptionState.subscriptionSignature ? 'sync' : 'activate',
        title: 'Coverage',
      }
    }

    if (subscriptionState.status === 'active') {
      return {
        badgeLabel: 'UNAVAILABLE',
        badgeTone: 'unavailable',
        detail: 'Local subscription is active, but live cover status could not be verified.',
        metrics: stateMetrics(subscriptionState),
        primaryAction: 'sync',
        title: 'Coverage',
      }
    }

    return {
      badgeLabel: statusLabel(subscriptionState.status).toUpperCase(),
      badgeTone: 'failed',
      detail: `Subscription status is ${statusLabel(subscriptionState.status).toLowerCase()}.`,
      metrics: stateMetrics(subscriptionState),
      primaryAction: 'manage',
      title: 'Coverage',
    }
  }

  if (coverEnrolled) {
    return {
      badgeLabel: 'UNAVAILABLE',
      badgeTone: 'unavailable',
      detail: 'Cover enrollment exists, but live subscription status is unavailable.',
      metrics: [],
      primaryAction: 'sync',
      title: 'Coverage',
    }
  }

  return {
    badgeLabel: 'NO COVER',
    badgeTone: 'none',
    detail: 'Activate Ember Cover to protect supported approvals before signing.',
    metrics: [],
    primaryAction: 'activate',
    title: 'Coverage',
  }
}
