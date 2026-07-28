/// <reference path="../../.wxt/types/paths.d.ts" />
import { getSignatureFromTransaction, getTransactionDecoder } from '@solana/kit'
import type { SolanaSignMessageInput, SolanaSignTransactionInput } from '@solana/wallet-standard-features'
import type { StandardConnectInput } from '@wallet-standard/core'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { browser } from 'wxt/browser'

import { base58Encode } from '../crypto/base58.ts'
import type { CoverCapContext, CoverDebugInfo, CoverDecision, CoverStatus, RiskBand } from '../cover/ember-types.ts'
import { isCoverable } from '../cover/ember-types.ts'
import { decodeTransportBytes } from '../messaging/transport-bytes.ts'
import type {
  TransportConnectOutput,
  TransportSignMessageOutput,
  TransportSignTransactionOutput,
} from '../messaging/transport.ts'
import { buildConnectAccount } from './build-account.ts'
import { coverRecords, toWalletCoverStatus } from './cover-records.ts'
import type { CoverProvider } from './cover-service.ts'
import { topRightPopupPosition } from './popup-position.ts'
import { buildSignMessageOutputs } from './sign-message-output.ts'
import { buildSignTransactionOutputs } from './sign-transaction-output.ts'
import { decodeTransactionSummary } from '../entrypoints/request/decode-transaction.ts'
import { walletClusterForChain } from '../wallet-standard/chains.ts'

/** The SW-side signer the request service needs. The real VaultController satisfies this. */
export interface VaultSigner {
  getAddress(): Promise<string | null>
  sign(message: Uint8Array): Promise<Uint8Array>
}

/** OPAQUE cover summary for the UI — status + band only, never reasonCodes. */
export interface CoverSummary {
  coverStatus: CoverStatus
  riskBand: RiskBand
  decisionExpiresAt?: string
  capContext?: CoverCapContext
  coveredTxCountImpact?: number
  debug?: CoverDebugInfo
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) {
    s += String.fromCharCode(byte)
  }
  return btoa(s)
}

function coverSummary(decision: CoverDecision): CoverSummary {
  return {
    coverStatus: decision.coverStatus,
    riskBand: decision.riskBand,
    decisionExpiresAt: decision.decisionExpiresAt,
    ...(decision.capContext === undefined ? {} : { capContext: decision.capContext }),
    ...(decision.coveredTxCountImpact === undefined ? {} : { coveredTxCountImpact: decision.coveredTxCountImpact }),
    ...(decision.debug === undefined ? {} : { debug: decision.debug }),
  }
}

type PendingRequest =
  | {
      type: 'connect'
      id: string
      data: StandardConnectInput | undefined
      windowId: number
      origin?: string
      resolve: (data: TransportConnectOutput) => void
      reject: (reason: Error) => void
    }
  | {
      type: 'signMessage'
      id: string
      data: SolanaSignMessageInput[]
      windowId: number
      origin?: string
      resolve: (data: TransportSignMessageOutput[]) => void
      reject: (reason: Error) => void
      coverDecision?: CoverDecision | null
      reviewedBytesBase64?: string
    }
  | {
      type: 'signTransaction'
      id: string
      data: SolanaSignTransactionInput[]
      windowId: number
      origin?: string
      resolve: (data: TransportSignTransactionOutput[]) => void
      reject: (reason: Error) => void
      coverDecision?: CoverDecision | null
      reviewedBytesBase64?: string
    }

type RequestType = PendingRequest['type']
type DataType<T extends RequestType> = Extract<PendingRequest, { type: T }>['data']
type ResolveType<T extends RequestType> =
  Extract<PendingRequest, { type: T }> extends { resolve: (data: infer R) => void } ? R : never

/** Read-only view of the pending request, safe to send to the popup. */
export interface PendingRequestView {
  /** Per-request nonce. The approval UI captures this and passes it to approve/reject so a
   *  stale still-open window can never act on a different, later request. */
  id: string
  type: RequestType
  data: PendingRequest['data']
  origin?: string
  cover?: CoverSummary
}

/** The NARROW surface the approval popup may call. `create` is absent on purpose.
 *  The optional `id` guards against a stale window: when supplied it must match the
 *  current pending request or the call throws `Stale request`. */
export interface RequestApproval {
  get(): PendingRequestView | null
  refreshCover(): Promise<PendingRequestView | null>
  approveConnect(id?: string): Promise<void>
  approveSignMessage(id?: string): Promise<void>
  approveSignTransaction(id?: string): Promise<void>
  reject(id?: string): void
}

function typeToSlug(type: RequestType): string {
  switch (type) {
    case 'connect':
      return 'connect'
    case 'signMessage':
      return 'sign-message'
    case 'signTransaction':
      return 'sign-transaction'
  }
}

export class RequestService implements RequestApproval {
  #request: PendingRequest | null = null
  #seq = 0
  #signer: VaultSigner
  #cover: CoverProvider | undefined

  constructor(signer: VaultSigner, cover?: CoverProvider) {
    this.#signer = signer
    this.#cover = cover
    browser.windows.onRemoved.addListener((windowId: number) => {
      if (this.#request && this.#request.windowId === windowId) {
        this.#request.reject(new Error('Request closed'))
        this.#clear()
      }
    })
  }

  async create<T extends RequestType>(type: T, data: DataType<T>, origin?: string): Promise<ResolveType<T>> {
    if (this.#request) {
      throw new Error('Request already exists')
    }
    if (type === 'signTransaction') {
      for (const input of data as SolanaSignTransactionInput[]) {
        walletClusterForChain(input.chain)
      }
    }
    const windowId = await this.#createPopupWindow(type)
    this.#seq += 1
    const id = String(this.#seq)
    const pending = new Promise<ResolveType<T>>((resolve, reject) => {
      this.#request = {
        type,
        id,
        data,
        windowId,
        ...(origin === undefined ? {} : { origin }),
        resolve,
        reject,
      } as PendingRequest
    })
    const request = this.#request as PendingRequest | null
    if (
      this.#cover &&
      (request?.type === 'signTransaction' || request?.type === 'signMessage') &&
      request.data.length === 1
    ) {
      void this.#fetchCover(request)
    }
    return await pending
  }

  /** Fire pre-sign in parallel and attach the OPAQUE decision. Fail-open: never throws. */
  async #fetchCover(request: PendingRequest): Promise<void> {
    try {
      if (!this.#cover) {
        return
      }
      if (request.type === 'signTransaction') {
        const first = request.data[0]
        if (!first || first.transaction == null) {
          return
        }
        const transactionBytes = toBase64(decodeTransportBytes(first.transaction))
        const decision = await this.#cover.preSign({
          transactionBytes,
          cluster: walletClusterForChain(first.chain),
          ...(request.origin === undefined ? {} : { dappUrl: request.origin }),
        })
        if (this.#request === request) {
          request.coverDecision = decision
          request.reviewedBytesBase64 = transactionBytes
        }
      }
      if (request.type === 'signMessage') {
        const first = request.data[0]
        if (!first || first.message == null) {
          return
        }
        const messageBytes = toBase64(decodeTransportBytes(first.message))
        const decision = await this.#cover.preSignMessage({
          messageBytes,
          walletMethod: 'signMessage',
          messageKind: 'wallet_standard_sign_message',
          ...(request.origin === undefined ? {} : { dappUrl: request.origin }),
        })
        if (this.#request === request) {
          request.coverDecision = decision
          request.reviewedBytesBase64 = messageBytes
        }
      }
    } catch {
      // fail-open: leave coverDecision unset
    }
  }

  get(): PendingRequestView | null {
    if (!this.#request) {
      return null
    }
    const { id, type, data, origin } = this.#request
    const cover =
      (this.#request.type === 'signTransaction' || this.#request.type === 'signMessage') && this.#request.coverDecision
        ? coverSummary(this.#request.coverDecision)
        : undefined
    return {
      id,
      type,
      data,
      ...(origin === undefined ? {} : { origin }),
      ...(cover === undefined ? {} : { cover }),
    }
  }

  async currentAddress(): Promise<string | null> {
    return await this.#signer.getAddress()
  }

  async refreshCover(): Promise<PendingRequestView | null> {
    const request = this.#request
    if (!request || (request.type !== 'signTransaction' && request.type !== 'signMessage')) {
      return this.get()
    }
    if (request.data.length !== 1) {
      return this.get()
    }
    delete request.coverDecision
    await this.#fetchCover(request)
    return this.get()
  }

  /** SW-side: build the account from the vault and resolve the dapp promise. */
  async approveConnect(id?: string): Promise<void> {
    const request = this.#request
    if (!request || request.type !== 'connect') {
      throw new Error('No connect request to approve')
    }
    if (id !== undefined && request.id !== id) {
      throw new Error('Stale request')
    }
    const address = await this.#signer.getAddress()
    if (!address) {
      throw new Error('No vault')
    }
    // If the user closed the window during the await, onRemoved already rejected the dapp and
    // cleared the slot. Bail before resolving so a cancelled request produces no result.
    if (this.#request !== request) {
      throw new Error('Request closed')
    }
    const account = buildConnectAccount(address)
    request.resolve({ accounts: [account] } as unknown as TransportConnectOutput)
    this.#clear()
    void this.#closeWindow(request.windowId)
  }

  /** SW-side: sign through the injected vault signer (key never leaves SW). */
  async approveSignMessage(id?: string): Promise<void> {
    const request = this.#request
    if (!request || request.type !== 'signMessage') {
      throw new Error('No signMessage request to approve')
    }
    if (id !== undefined && request.id !== id) {
      throw new Error('Stale request')
    }
    if (request.data.length !== 1) {
      throw new Error('Multiple message signing is not supported')
    }
    const address = await this.#signer.getAddress()
    if (!address) {
      throw new Error('No vault')
    }
    const decision = request.coverDecision
    if (decision && isCoverable(decision) && Date.now() >= Date.parse(decision.decisionExpiresAt)) {
      throw new Error('Cover decision expired')
    }
    const currentMessageBytes = toBase64(decodeTransportBytes(request.data[0]!.message))
    if (
      decision?.requestId &&
      request.reviewedBytesBase64 !== undefined &&
      request.reviewedBytesBase64 !== currentMessageBytes
    ) {
      throw new Error('Signing bytes changed after Ember review')
    }
    const outputs = await buildSignMessageOutputs(request.data, (m) => this.#signer.sign(m), address)
    // The user may have closed the window mid-sign; if so onRemoved already rejected the dapp.
    // Bail before resolving or sending post-sign evidence so the cancelled request yields nothing.
    if (this.#request !== request) {
      throw new Error('Request closed')
    }
    const first = outputs[0]
    const decisionIsFresh = decision ? Date.now() < Date.parse(decision.decisionExpiresAt) : false
    if (
      this.#cover &&
      decision &&
      decision.coverStatus !== 'unavailable' &&
      decisionIsFresh &&
      decision.requestId &&
      first?.signedMessage &&
      first.signature
    ) {
      await this.#cover.postSignMessage({
        requestId: decision.requestId,
        signedMessage: toBase64(new Uint8Array(first.signedMessage)),
        signature: base58Encode(new Uint8Array(first.signature)),
        signingWalletPublicKey: address,
        walletTimestamp: new Date().toISOString(),
      })
    }
    request.resolve(outputs as unknown as TransportSignMessageOutput[])
    this.#clear()
    void this.#closeWindow(request.windowId)
  }

  async approveSignTransaction(id?: string): Promise<void> {
    const request = this.#request
    if (!request || request.type !== 'signTransaction') {
      throw new Error('No signTransaction request to approve')
    }
    if (id !== undefined && request.id !== id) {
      throw new Error('Stale request')
    }
    if (request.data.length !== 1) {
      throw new Error('Multiple transaction signing is not supported')
    }
    const address = await this.#signer.getAddress()
    if (!address) {
      throw new Error('No vault')
    }
    const decision = request.coverDecision
    if (decision && isCoverable(decision) && Date.now() >= Date.parse(decision.decisionExpiresAt)) {
      throw new Error('Cover decision expired')
    }
    const currentTransactionBytes = toBase64(
      decodeTransportBytes(request.data[0]!.transaction),
    )
    if (
      decision?.requestId &&
      request.reviewedBytesBase64 !== undefined &&
      request.reviewedBytesBase64 !== currentTransactionBytes
    ) {
      throw new Error('Signing bytes changed after Ember review')
    }
    const outputs = await buildSignTransactionOutputs(request.data, (m) => this.#signer.sign(m), address)
    // The user may have closed the window mid-sign; if so onRemoved already rejected the dapp.
    // Bail before resolving, recording, or sending post-sign evidence for a cancelled request.
    if (this.#request !== request) {
      throw new Error('Request closed')
    }
    const signedTransaction = outputs[0]?.signedTransaction
    // The transaction's primary (fee-payer) signature is its on-chain id — the same
    // base58 value getSignaturesForAddress returns — so the Activity feed can match it.
    let signature: string | null = null
    if (signedTransaction) {
      try {
        signature = getSignatureFromTransaction(getTransactionDecoder().decode(signedTransaction))
      } catch {
        signature = null
      }
    }
    const decisionIsFresh = decision ? Date.now() < Date.parse(decision.decisionExpiresAt) : false
    // Record the cover verdict locally for the Activity feed. This is a display
    // cache only; Ember's lifecycle endpoints remain authoritative.
    if (decision && signature) {
      try {
        const unsignedTransaction = request.data[0]?.transaction
        const summary = unsignedTransaction ? decodeTransactionSummary(unsignedTransaction) : null
        await coverRecords.record({
          signature,
          walletAddress: address,
          coverStatus: toWalletCoverStatus(decision.coverStatus),
          riskBand: decision.riskBand,
          requestId: decision.requestId ?? null,
          dappOrigin: request.origin ?? null,
          title: summary?.primaryAction.label ?? null,
          actionKind: summary?.primaryAction.kind ?? null,
          amount: summary?.primaryAction.amount ?? null,
          tokenSymbol: summary?.primaryAction.kind === 'sol_transfer' ? 'SOL' : null,
          tokenMint: summary?.primaryAction.tokenMint ?? null,
          recipient: summary?.primaryAction.recipient ?? null,
          source: summary?.primaryAction.source ?? null,
          feePayer: summary?.feePayer ?? address,
          programs: summary?.instructions.map((instruction) => instruction.programName) ?? [],
          cluster: walletClusterForChain(request.data[0]?.chain),
          transactionStatus: 'signed',
          broadcastOwner: 'dapp',
        })
      } catch {
        // Activity cache failure does not change the Ember evidence invariant.
      }
    }
    // The exact signed bytes must be durable before the dapp receives them.
    if (
      this.#cover &&
      decision &&
      decision.coverStatus !== 'unavailable' &&
      decisionIsFresh &&
      decision.requestId &&
      signedTransaction
    ) {
      await this.#cover.postSign({
        requestId: decision.requestId,
        signedBytes: toBase64(new Uint8Array(signedTransaction)),
        ...(signature ? { signature } : {}),
        signingWalletPublicKey: address,
        walletTimestamp: new Date().toISOString(),
      })
    }
    request.resolve(outputs as unknown as TransportSignTransactionOutput[])
    this.#clear()
    void this.#closeWindow(request.windowId)
  }

  reject(id?: string): void {
    if (!this.#request) {
      throw new Error('No request to reject')
    }
    if (id !== undefined && this.#request.id !== id) {
      throw new Error('Stale request')
    }
    this.#request.reject(new Error('Request rejected'))
    void this.#close()
  }

  async #createPopupWindow(type: RequestType): Promise<number> {
    const slug = typeToSlug(type)
    // Sized so the fixed 360x600 content (see global.css --ec-app-width/height)
    // fits inside the OS window chrome. Matches the action popup footprint.
    const width = 376
    const height = 632
    const win = await browser.windows.create({
      type: 'popup',
      focused: true,
      width,
      height,
      // Pin it to the top-right of the active browser window, under the toolbar
      // icons (the Phantom/MetaMask convention) instead of OS-default centering.
      ...(await this.#topRightPosition(width)),
      // `request.html` is a later entrypoint, so it is not in the generated PublicPath union
      // yet. Build from the extension root (a valid PublicPath) and append the request path.
      url: `${browser.runtime.getURL('/')}request.html#/${slug}`,
    })
    const id = win?.id
    if (id === undefined) {
      throw new Error('Failed to create request window')
    }
    return id
  }

  /** Top-right corner of the focused browser window, or {} if its bounds are unknown. */
  async #topRightPosition(popupWidth: number): Promise<{ left: number; top: number } | Record<string, never>> {
    try {
      const focused = await browser.windows.getLastFocused()
      if (focused?.left === undefined || focused.top === undefined || focused.width === undefined) {
        return {}
      }
      return topRightPopupPosition({ left: focused.left, top: focused.top, width: focused.width }, popupWidth, 16)
    } catch {
      return {}
    }
  }

  #clear(): void {
    this.#request = null
  }

  async #close(): Promise<void> {
    const id = this.#request?.windowId
    this.#clear()
    if (id !== undefined) {
      await this.#closeWindow(id)
    }
  }

  async #closeWindow(id: number): Promise<void> {
    try {
      await browser.windows.remove(id)
    } catch {
      // already gone
    }
  }
}

const REQUEST_SERVICE_KEY = 'ember.RequestService' as ProxyServiceKey<RequestApproval>
let realRequestService: RequestService | undefined

/** SW only: construct + register the real instance; returns it so actions can call create(). */
export function registerRequestService(signer: VaultSigner, cover?: CoverProvider): RequestService {
  realRequestService = new RequestService(signer, cover)
  const approval: RequestApproval = {
    get: () => realRequestService?.get() ?? null,
    refreshCover: () => realRequestService?.refreshCover() ?? Promise.resolve(null),
    approveConnect: (id?: string) =>
      realRequestService?.approveConnect(id) ?? Promise.reject(new Error('RequestService not registered')),
    approveSignMessage: (id?: string) =>
      realRequestService?.approveSignMessage(id) ?? Promise.reject(new Error('RequestService not registered')),
    approveSignTransaction: (id?: string) =>
      realRequestService?.approveSignTransaction(id) ?? Promise.reject(new Error('RequestService not registered')),
    reject: (id?: string) => {
      if (!realRequestService) {
        throw new Error('RequestService not registered')
      }
      realRequestService.reject(id)
    },
  }
  registerService(REQUEST_SERVICE_KEY, approval)
  return realRequestService
}

/** SW only: the real instance (for actions create()). */
export function requestService(): RequestService {
  if (!realRequestService) {
    throw new Error('RequestService not registered')
  }
  return realRequestService
}

/** UI context: a proxy to the NARROW RequestApproval surface (no `create`). */
export function getRequestApproval(): ProxyService<RequestApproval> {
  return createProxyService<RequestApproval>(REQUEST_SERVICE_KEY)
}
