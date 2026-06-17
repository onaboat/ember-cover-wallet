/// <reference path="../../.wxt/types/paths.d.ts" />
import type { SolanaSignMessageInput, SolanaSignTransactionInput } from '@solana/wallet-standard-features'
import type { StandardConnectInput } from '@wallet-standard/core'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { browser } from 'wxt/browser'

import type { CoverDecision, CoverStatus, RiskBand } from '../cover/ember-types.ts'
import { decodeTransportBytes } from '../messaging/transport-bytes.ts'
import type {
  TransportConnectOutput,
  TransportSignMessageOutput,
  TransportSignTransactionOutput,
} from '../messaging/transport.ts'
import { buildConnectAccount } from './build-account.ts'
import type { CoverProvider } from './cover-service.ts'
import { buildSignMessageOutputs } from './sign-message-output.ts'
import { buildSignTransactionOutputs } from './sign-transaction-output.ts'

/** The SW-side signer the request service needs. The real VaultController satisfies this. */
export interface VaultSigner {
  getAddress(): Promise<string | null>
  sign(message: Uint8Array): Promise<Uint8Array>
}

/** OPAQUE cover summary for the UI — status + band only, never reasonCodes. */
export interface CoverSummary {
  coverStatus: CoverStatus
  riskBand: RiskBand
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) {
    s += String.fromCharCode(byte)
  }
  return btoa(s)
}

type PendingRequest =
  | {
      type: 'connect'
      data: StandardConnectInput | undefined
      windowId: number
      origin?: string
      resolve: (data: TransportConnectOutput) => void
      reject: (reason: Error) => void
    }
  | {
      type: 'signMessage'
      data: SolanaSignMessageInput[]
      windowId: number
      origin?: string
      resolve: (data: TransportSignMessageOutput[]) => void
      reject: (reason: Error) => void
    }
  | {
      type: 'signTransaction'
      data: SolanaSignTransactionInput[]
      windowId: number
      origin?: string
      resolve: (data: TransportSignTransactionOutput[]) => void
      reject: (reason: Error) => void
      coverDecision?: CoverDecision | null
    }

type RequestType = PendingRequest['type']
type DataType<T extends RequestType> = Extract<PendingRequest, { type: T }>['data']
type ResolveType<T extends RequestType> =
  Extract<PendingRequest, { type: T }> extends { resolve: (data: infer R) => void } ? R : never

/** Read-only view of the pending request, safe to send to the popup. */
export interface PendingRequestView {
  type: RequestType
  data: PendingRequest['data']
  origin?: string
  cover?: CoverSummary
}

/** The NARROW surface the approval popup may call. `create` is absent on purpose. */
export interface RequestApproval {
  get(): PendingRequestView | null
  approveConnect(): Promise<void>
  approveSignMessage(): Promise<void>
  approveSignTransaction(): Promise<void>
  reject(): void
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
    const windowId = await this.#createPopupWindow(type)
    const pending = new Promise<ResolveType<T>>((resolve, reject) => {
      this.#request = {
        type,
        data,
        windowId,
        ...(origin === undefined ? {} : { origin }),
        resolve,
        reject,
      } as PendingRequest
    })
    if (type === 'signTransaction' && this.#cover && this.#request) {
      void this.#fetchCover(this.#request)
    }
    return await pending
  }

  /** Fire pre-sign in parallel and attach the OPAQUE decision. Fail-open: never throws. */
  async #fetchCover(request: PendingRequest): Promise<void> {
    try {
      if (request.type !== 'signTransaction' || !this.#cover) {
        return
      }
      const first = request.data[0]
      if (!first || first.transaction == null) {
        return
      }
      const transactionBytes = toBase64(decodeTransportBytes(first.transaction))
      const decision = await this.#cover.preSign({
        transactionBytes,
        ...(request.origin === undefined ? {} : { dappUrl: request.origin }),
      })
      if (this.#request === request) {
        request.coverDecision = decision
      }
    } catch {
      // fail-open: leave coverDecision unset
    }
  }

  get(): PendingRequestView | null {
    if (!this.#request) {
      return null
    }
    const { type, data, origin } = this.#request
    const cover =
      this.#request.type === 'signTransaction' && this.#request.coverDecision
        ? { coverStatus: this.#request.coverDecision.coverStatus, riskBand: this.#request.coverDecision.riskBand }
        : undefined
    return {
      type,
      data,
      ...(origin === undefined ? {} : { origin }),
      ...(cover === undefined ? {} : { cover }),
    }
  }

  /** SW-side: build the account from the vault and resolve the dapp promise. */
  async approveConnect(): Promise<void> {
    const request = this.#request
    if (!request || request.type !== 'connect') {
      throw new Error('No connect request to approve')
    }
    const address = await this.#signer.getAddress()
    if (!address) {
      throw new Error('No vault')
    }
    const account = buildConnectAccount(address)
    request.resolve({ accounts: [account] } as unknown as TransportConnectOutput)
    await this.#close()
  }

  /** SW-side: sign through the injected vault signer (key never leaves SW). */
  async approveSignMessage(): Promise<void> {
    const request = this.#request
    if (!request || request.type !== 'signMessage') {
      throw new Error('No signMessage request to approve')
    }
    const outputs = await buildSignMessageOutputs(request.data, (m) => this.#signer.sign(m))
    request.resolve(outputs as unknown as TransportSignMessageOutput[])
    await this.#close()
  }

  async approveSignTransaction(): Promise<void> {
    const request = this.#request
    if (!request || request.type !== 'signTransaction') {
      throw new Error('No signTransaction request to approve')
    }
    const address = await this.#signer.getAddress()
    if (!address) {
      throw new Error('No vault')
    }
    const outputs = await buildSignTransactionOutputs(request.data, (m) => this.#signer.sign(m), address)
    request.resolve(outputs as unknown as TransportSignTransactionOutput[])
    const decision = request.coverDecision
    const signedTransaction = outputs[0]?.signedTransaction
    if (this.#cover && decision && decision.requestId && signedTransaction) {
      void this.#cover.postSign({
        requestId: decision.requestId,
        signedBytes: toBase64(new Uint8Array(signedTransaction)),
        signingWalletPublicKey: address,
        walletTimestamp: new Date().toISOString(),
      })
    }
    await this.#close()
  }

  reject(): void {
    if (!this.#request) {
      throw new Error('No request to reject')
    }
    this.#request.reject(new Error('Request rejected'))
    void this.#close()
  }

  async #createPopupWindow(type: RequestType): Promise<number> {
    const slug = typeToSlug(type)
    const win = await browser.windows.create({
      type: 'popup',
      focused: true,
      width: 400,
      height: 600,
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

  #clear(): void {
    this.#request = null
  }

  async #close(): Promise<void> {
    const id = this.#request?.windowId
    this.#clear()
    if (id !== undefined) {
      try {
        await browser.windows.remove(id)
      } catch {
        // already gone
      }
    }
  }
}

const REQUEST_SERVICE_KEY = 'ember.RequestService' as ProxyServiceKey<RequestApproval>
let realRequestService: RequestService | undefined

/** SW only: construct + register the real instance; returns it so actions can call create(). */
export function registerRequestService(signer: VaultSigner, cover?: CoverProvider): RequestService {
  realRequestService = new RequestService(signer, cover)
  registerService(REQUEST_SERVICE_KEY, realRequestService)
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
