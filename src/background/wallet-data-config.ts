import { EMBER_CONFIG } from '../cover/ember-config.ts'

export type WalletCluster = 'devnet' | 'mainnet-beta'

export interface WalletClusterConfig {
  id: WalletCluster
  label: string
  rpcUrl: string
  explorerCluster: string | null
}

export const DEFAULT_WALLET_CLUSTER: WalletCluster = EMBER_CONFIG.expectedCluster

function configuredRpcUrl(value: string | boolean | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

const CONFIGURED_RPC_URL = import.meta.env?.WXT_SOLANA_RPC_URL

const ALL_WALLET_CLUSTERS: readonly WalletClusterConfig[] = [
  {
    id: 'devnet',
    label: 'Devnet',
    rpcUrl:
      DEFAULT_WALLET_CLUSTER === 'devnet'
        ? configuredRpcUrl(CONFIGURED_RPC_URL, 'https://api.devnet.solana.com')
        : 'https://api.devnet.solana.com',
    explorerCluster: 'devnet',
  },
  {
    id: 'mainnet-beta',
    label: 'Mainnet',
    rpcUrl:
      DEFAULT_WALLET_CLUSTER === 'mainnet-beta'
        ? configuredRpcUrl(CONFIGURED_RPC_URL, 'https://api.mainnet-beta.solana.com')
        : 'https://api.mainnet-beta.solana.com',
    explorerCluster: null,
  },
] as const

/** One distributable is bound to one cluster; the selector cannot cross that boundary. */
export const WALLET_CLUSTER_OPTIONS: readonly WalletClusterConfig[] =
  ALL_WALLET_CLUSTERS.filter((cluster) => cluster.id === DEFAULT_WALLET_CLUSTER)

export function isWalletCluster(value: unknown): value is WalletCluster {
  return typeof value === 'string' && WALLET_CLUSTER_OPTIONS.some((cluster) => cluster.id === value)
}

export function walletClusterConfig(cluster: WalletCluster): WalletClusterConfig {
  const config = ALL_WALLET_CLUSTERS.find((option) => option.id === cluster)
  if (!config) throw new Error(`Unknown Solana cluster: ${cluster}`)
  return config
}

export function explorerTransactionUrl(signature: string, cluster: WalletCluster): string {
  const config = walletClusterConfig(cluster)
  const url = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`
  return config.explorerCluster ? `${url}?cluster=${encodeURIComponent(config.explorerCluster)}` : url
}
