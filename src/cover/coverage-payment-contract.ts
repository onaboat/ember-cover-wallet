import type { IntegrationEnvironment, SignedQuoteResponse } from '@embercover/wallet-sdk'

import type { WalletCluster } from '../background/wallet-data-config.ts'

export const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
export const DEVNET_QA_OFFER_ID = 'offer_devnet-qa-core-annual'
export const DEVNET_QA_PRICE_BASE_UNITS = '1000000'
export const PRODUCTION_PRICE_BASE_UNITS = '249990000'

export interface CoveragePaymentContractContext {
  environment: IntegrationEnvironment
  expectedCluster: WalletCluster
  expectedGenesisHash: string | null
  nowMs: number
  walletAddress: string
}

export interface ValidatedCoveragePaymentContract {
  quote: SignedQuoteResponse
  schedule: NonNullable<SignedQuoteResponse['payload']['benefitSchedule']>
}

/**
 * Validate the server-signed business contract before any Solana account read,
 * simulation, signing request, or broadcast is allowed to begin.
 */
export function validateCoveragePaymentContract(
  quote: SignedQuoteResponse,
  context: CoveragePaymentContractContext,
): ValidatedCoveragePaymentContract {
  const payload = quote.payload
  const payment = payload.payment
  const productionContract =
    payload.mode === 'live' &&
    payload.schemaVersion === 3 &&
    payload.paymentAllowed &&
    payload.createsCoverage &&
    payload.offer.environment === 'production' &&
    payload.offer.cluster === 'mainnet-beta' &&
    payload.offer.offerId === 'offer_core-annual' &&
    payload.offer.price === PRODUCTION_PRICE_BASE_UNITS &&
    payment.amount === PRODUCTION_PRICE_BASE_UNITS &&
    payment.mint === MAINNET_USDC_MINT
  const devnetQaContract =
    payload.mode === 'test' &&
    payload.schemaVersion === 3 &&
    payload.paymentAllowed &&
    payload.createsCoverage &&
    payload.offer.environment === 'sandbox' &&
    payload.offer.cluster === 'devnet' &&
    payload.offer.offerId === DEVNET_QA_OFFER_ID &&
    payload.offer.price === DEVNET_QA_PRICE_BASE_UNITS &&
    payment.amount === DEVNET_QA_PRICE_BASE_UNITS &&
    payment.mint === DEVNET_USDC_MINT
  if (!productionContract && !devnetQaContract) {
    throw new Error('This verified quote is non-payable test data')
  }

  const schedule = payload.benefitSchedule
  if (
    !schedule ||
    schedule.coverageDurationMonths !== 12 ||
    schedule.benefitPeriodCount !== 12 ||
    schedule.benefitPeriodLimit !== '10000000000' ||
    payload.offer.aggregateLimit !== '120000000000' ||
    payload.offer.perLossLimit !== '10000000000'
  ) {
    throw new Error('The quote does not contain the approved P15 monthly benefit schedule')
  }
  if (
    payload.protectedWallet !== context.walletAddress ||
    payload.payerWallet !== context.walletAddress
  ) {
    throw new Error('The quote is bound to a different wallet')
  }
  if (
    payload.offer.cluster !== context.expectedCluster ||
    payload.offer.environment !== context.environment
  ) {
    throw new Error('The payable quote does not match this wallet build environment')
  }
  if (
    !context.expectedGenesisHash ||
    payment.genesisHash !== context.expectedGenesisHash
  ) {
    throw new Error('The quote is not bound to the expected Solana genesis hash')
  }
  if (payment.tokenProgram !== CLASSIC_TOKEN_PROGRAM) {
    throw new Error('The quote does not use the supported classic SPL Token program')
  }
  if (!payment.treasuryOwner) {
    throw new Error('The quote does not name the treasury owner')
  }
  if (context.nowMs >= Date.parse(payload.validity.expiresAt)) {
    throw new Error('The server-signed quote expired; request a fresh quote')
  }

  return { quote, schedule }
}
