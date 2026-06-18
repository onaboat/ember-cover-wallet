import { address as toAddress, createSolanaRpc, devnet, mainnet } from '@solana/kit'
import type { Address } from '@solana/kit'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { storage } from 'wxt/utils/storage'

import { COVER_CONFIG } from './cover-config.ts'
import { coverSessionHeaderForWallet } from './cover-service.ts'
import { signWithSession } from './session-key.ts'
import {
  DEFAULT_WALLET_CLUSTER,
  explorerTransactionUrl,
  isWalletCluster,
  walletClusterConfig,
} from './wallet-data-config.ts'
import type { WalletCluster } from './wallet-data-config.ts'

const CLUSTER_KEY = 'local:ember-wallet-data-cluster' as const
const DEFAULT_ACTIVITY_LIMIT = 10
const MAX_ACTIVITY_LIMIT = 50
const ACTIVITY_TIMEOUT_MS = 4000
const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

type RpcSend<T> = {
  send(): Promise<T>
}

type WalletBalanceRpcResponse = Readonly<{
  value: bigint | number | string
}>

type WalletRpcActivityItem = Readonly<{
  blockTime: bigint | number | null
  confirmationStatus: string | null
  err: unknown | null
  memo: string | null
  signature: string
  slot: bigint | number
}>

type WalletRpcTokenAccount = Readonly<{
  pubkey: string
  account: Readonly<{
    owner: string
    data: Readonly<{
      parsed?: {
        info?: {
          mint?: string
          owner?: string
          tokenAmount?: {
            amount?: string
            decimals?: number
            uiAmountString?: string
          }
        }
        type?: string
      }
    }>
  }>
}>

type WalletTokenAccountsRpcResponse = Readonly<{
  value: readonly WalletRpcTokenAccount[]
}>

interface WalletDataRpcClient {
  getBalance(address: Address, config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<WalletBalanceRpcResponse>
  getSignaturesForAddress(
    address: Address,
    config?: Readonly<{ commitment: 'confirmed'; limit: number }>,
  ): RpcSend<readonly WalletRpcActivityItem[]>
  getTokenAccountsByOwner(
    owner: Address,
    filter: Readonly<{ programId: Address }>,
    config: Readonly<{ commitment: 'confirmed'; encoding: 'jsonParsed' }>,
  ): RpcSend<WalletTokenAccountsRpcResponse>
}

export interface WalletActivityItem {
  signature: string
  slot: number
  blockTime: number | null
  confirmationStatus: string | null
  failed: boolean
  explorerUrl: string
}

export interface WalletTokenBalance {
  tokenAccount: string
  mint: string
  owner: string | null
  programId: string
  rawAmount: string
  decimals: number
  uiAmount: string
  label: string
}

export type WalletCoverStatus = 'covered' | 'not_covered' | 'unavailable' | 'unknown'

export interface WalletEmberActivityItem {
  id: string
  type: string
  timestamp: string
  dappOrigin: string | null
  requestId: string | null
  signature: string | null
  coverStatus: WalletCoverStatus
  riskBand: string | null
  title: string
  amount: string | null
  tokenSymbol: string | null
  tokenMint: string | null
  recipient: string | null
  onchainStatus: string | null
}

export interface WalletDataSnapshot {
  cluster: WalletCluster
  address: string
  solBalance: string
  lamports: string
  tokenBalances: WalletTokenBalance[]
  tokenBalancesUnavailable: boolean
  activity: WalletActivityItem[]
  emberActivity: WalletEmberActivityItem[]
  emberActivityUnavailable: boolean
}

export interface WalletDataUI {
  getCluster(): Promise<WalletCluster>
  setCluster(cluster: WalletCluster): Promise<void>
  getSnapshot(address: string, limit?: number): Promise<WalletDataSnapshot>
}

interface WalletDataProviderDeps {
  rpcFactory?: (cluster: WalletCluster) => WalletDataRpcClient
  fetch?: typeof fetch
  now?: () => number
}

function rpcUrlFor(cluster: WalletCluster) {
  const url = walletClusterConfig(cluster).rpcUrl
  return cluster === 'devnet' ? devnet(url) : mainnet(url)
}

function createWalletRpc(cluster: WalletCluster): WalletDataRpcClient {
  return createSolanaRpc(rpcUrlFor(cluster)) as unknown as WalletDataRpcClient
}

function asBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

function rpcNumber(value: bigint | number | null): number | null {
  if (value === null) {
    return null
  }
  return Number(value)
}

function activityLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) {
    return DEFAULT_ACTIVITY_LIMIT
  }
  return Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Math.trunc(limit)))
}

export function formatLamportsAsSol(value: bigint | number | string): string {
  return formatIntegerAmount(value, 9)
}

function formatIntegerAmount(value: bigint | number | string, decimals: number): string {
  const lamports = asBigInt(value)
  const sign = lamports < 0n ? '-' : ''
  const absolute = lamports < 0n ? -lamports : lamports
  const scale = 10n ** BigInt(Math.max(0, decimals))
  const whole = scale === 0n ? absolute : absolute / scale
  const fraction = scale === 0n ? 0n : absolute % scale
  const trimmedFraction = decimals > 0 ? fraction.toString().padStart(decimals, '0').replace(/0+$/, '') : ''
  return `${sign}${whole.toString()}${trimmedFraction ? `.${trimmedFraction}` : ''}`
}

export function formatTokenAmount(rawAmount: string, decimals: number): string {
  if (!/^-?\d+$/.test(rawAmount)) {
    return rawAmount
  }
  return formatIntegerAmount(rawAmount, decimals)
}

export function normalizeActivity(
  items: readonly WalletRpcActivityItem[],
  cluster: WalletCluster,
): WalletActivityItem[] {
  return items.map((item) => ({
    signature: item.signature,
    slot: rpcNumber(item.slot) ?? 0,
    blockTime: rpcNumber(item.blockTime),
    confirmationStatus: item.confirmationStatus,
    failed: item.err !== null,
    explorerUrl: explorerTransactionUrl(item.signature, cluster),
  }))
}

function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint
}

export function normalizeTokenBalances(accounts: readonly WalletRpcTokenAccount[]): WalletTokenBalance[] {
  return accounts
    .map((entry) => {
      const info = entry.account.data.parsed?.info
      const mint = info?.mint
      const rawAmount = info?.tokenAmount?.amount
      const decimals = info?.tokenAmount?.decimals
      if (!mint || rawAmount === undefined || decimals === undefined || rawAmount === '0') {
        return null
      }
      const uiAmount = info?.tokenAmount?.uiAmountString ?? formatTokenAmount(rawAmount, decimals)
      return {
        tokenAccount: String(entry.pubkey),
        mint,
        owner: info?.owner ?? null,
        programId: String(entry.account.owner),
        rawAmount,
        decimals,
        uiAmount,
        label: `Token ${shortMint(mint)}`,
      } satisfies WalletTokenBalance
    })
    .filter((item): item is WalletTokenBalance => item !== null)
}

function isWalletCoverStatus(value: unknown): value is WalletCoverStatus {
  return value === 'covered' || value === 'not_covered' || value === 'unavailable' || value === 'unknown'
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function normalizeEmberActivityItems(payload: unknown): WalletEmberActivityItem[] {
  const record = recordOf(payload)
  const rawItems = Array.isArray(record['items'])
    ? record['items']
    : Array.isArray(record['activity'])
      ? record['activity']
      : Array.isArray(payload)
        ? payload
        : []
  return rawItems.map((raw, index) => {
    const row = recordOf(raw)
    const summary = recordOf(row['summary'])
    const coverStatus = isWalletCoverStatus(row['coverStatus']) ? row['coverStatus'] : 'unknown'
    return {
      id: stringOrNull(row['id']) ?? stringOrNull(row['requestId']) ?? `activity-${index}`,
      type: stringOrNull(row['type']) ?? 'sign_transaction',
      timestamp: stringOrNull(row['timestamp']) ?? stringOrNull(row['walletTimestamp']) ?? '',
      dappOrigin: stringOrNull(row['dappOrigin']) ?? stringOrNull(row['dappUrl']),
      requestId: stringOrNull(row['requestId']),
      signature: stringOrNull(row['signature']),
      coverStatus,
      riskBand: stringOrNull(row['riskBand']),
      title: stringOrNull(summary['action']) ?? stringOrNull(row['title']) ?? 'Wallet activity',
      amount: stringOrNull(summary['amount']) ?? stringOrNull(row['amount']),
      tokenSymbol: stringOrNull(summary['tokenSymbol']) ?? stringOrNull(row['tokenSymbol']),
      tokenMint: stringOrNull(summary['tokenMint']) ?? stringOrNull(row['tokenMint']),
      recipient: stringOrNull(summary['recipient']) ?? stringOrNull(row['recipient']),
      onchainStatus: stringOrNull(row['onchainStatus']),
    }
  })
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export class WalletDataProvider implements WalletDataUI {
  #rpcFactory: (cluster: WalletCluster) => WalletDataRpcClient
  #fetch: typeof fetch
  #now: () => number

  constructor(deps: WalletDataProviderDeps = {}) {
    this.#rpcFactory = deps.rpcFactory ?? createWalletRpc
    this.#fetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
    this.#now = deps.now ?? Date.now
  }

  async getCluster(): Promise<WalletCluster> {
    const stored = await storage.getItem<unknown>(CLUSTER_KEY)
    return isWalletCluster(stored) ? stored : DEFAULT_WALLET_CLUSTER
  }

  async setCluster(cluster: WalletCluster): Promise<void> {
    if (!isWalletCluster(cluster)) {
      throw new Error('Unsupported wallet cluster')
    }
    await storage.setItem(CLUSTER_KEY, cluster)
  }

  async getSnapshot(walletAddress: string, limit?: number): Promise<WalletDataSnapshot> {
    const cluster = await this.getCluster()
    const rpc = this.#rpcFactory(cluster)
    const publicKey = toAddress(walletAddress)
    const [balance, activity, tokenBalances, emberActivity] = await Promise.all([
      rpc.getBalance(publicKey, { commitment: 'confirmed' }).send(),
      rpc.getSignaturesForAddress(publicKey, { commitment: 'confirmed', limit: activityLimit(limit) }).send(),
      this.#getTokenBalances(rpc, publicKey).catch(() => null),
      this.#getEmberActivity(walletAddress, cluster, activityLimit(limit)).catch(() => null),
    ])
    const lamports = asBigInt(balance.value)
    return {
      cluster,
      address: walletAddress,
      solBalance: formatLamportsAsSol(lamports),
      lamports: lamports.toString(),
      tokenBalances: tokenBalances ?? [],
      tokenBalancesUnavailable: tokenBalances === null,
      activity: normalizeActivity(activity, cluster),
      emberActivity: emberActivity ?? [],
      emberActivityUnavailable: emberActivity === null,
    }
  }

  async #getTokenBalances(rpc: WalletDataRpcClient, owner: Address): Promise<WalletTokenBalance[]> {
    const [tokenAccounts, token2022Accounts] = await Promise.all([
      rpc
        .getTokenAccountsByOwner(toAddress(owner), { programId: toAddress(TOKEN_PROGRAM_ADDRESS) }, { commitment: 'confirmed', encoding: 'jsonParsed' })
        .send(),
      rpc
        .getTokenAccountsByOwner(toAddress(owner), { programId: toAddress(TOKEN_2022_PROGRAM_ADDRESS) }, { commitment: 'confirmed', encoding: 'jsonParsed' })
        .send(),
    ])
    return normalizeTokenBalances([...tokenAccounts.value, ...token2022Accounts.value])
  }

  async #authHeader(method: string, path: string, body: string): Promise<string> {
    const ts = new Date(this.#now()).toISOString()
    const payload = `${method}\n${path}\n${ts}\n${body}`
    const sig = await signWithSession(new TextEncoder().encode(payload))
    return `${ts}.${toBase64(sig)}`
  }

  async #getEmberActivity(
    walletAddress: string,
    cluster: WalletCluster,
    limit: number,
  ): Promise<WalletEmberActivityItem[]> {
    const sessionHeader = await coverSessionHeaderForWallet(walletAddress)
    if (!sessionHeader) {
      return []
    }
    const path = '/wallets/activity'
    const body = JSON.stringify({ walletPublicKey: walletAddress, cluster, limit })
    const headers = {
      'content-type': 'application/json',
      'x-ember-auth': await this.#authHeader('POST', path, body),
      'x-ember-session': sessionHeader,
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ACTIVITY_TIMEOUT_MS)
    try {
      const response = await this.#fetch(COVER_CONFIG.proxyBaseUrl + path, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`activity HTTP ${response.status}`)
      }
      return normalizeEmberActivityItems(await response.json())
    } finally {
      clearTimeout(timer)
    }
  }
}

const WALLET_DATA_SERVICE_KEY = 'ember.WalletDataService' as ProxyServiceKey<WalletDataUI>

export function registerWalletDataService(provider = new WalletDataProvider()): WalletDataProvider {
  const facade: WalletDataUI = {
    getCluster: () => provider.getCluster(),
    setCluster: (cluster) => provider.setCluster(cluster),
    getSnapshot: (address, limit) => provider.getSnapshot(address, limit),
  }
  registerService(WALLET_DATA_SERVICE_KEY, facade)
  return provider
}

export function getWalletDataService(): ProxyService<WalletDataUI> {
  return createProxyService<WalletDataUI>(WALLET_DATA_SERVICE_KEY)
}
