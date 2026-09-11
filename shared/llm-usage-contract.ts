/** Money crosses API boundaries as decimal strings; null means unknown, never zero. */
export type DecimalAmount = string | null
export type ActualModelState = 'reported' | 'inferred' | 'not_reported'
export const UNPRICED_REASONS = ['no_price', 'usage_unavailable', 'unit_quantity_unavailable', 'unsupported_billing_unit', 'unknown_alias', 'price_version_missing', 'external_subscription', 'invalid_usage'] as const
export type UnpricedReason = typeof UNPRICED_REASONS[number]
export interface UsageFilter {
  source?: 'sub2api' | 'env' | 'byoa'
  platform?: string
  provider?: string
  capability?: string
  role?: string
  purpose?: string
  agentId?: string
  runId?: string
}
export interface SettlementAmounts {
  referenceCostUsd: DecimalAmount
  upstreamCostUsd: DecimalAmount
  quotaDebit: DecimalAmount
}
