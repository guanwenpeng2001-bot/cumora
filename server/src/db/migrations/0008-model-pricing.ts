import { createHash } from 'node:crypto'

/**
 * Migration 0008: model_pricing — the operator-visible price menu.
 *
 * One row per model id: per-1M-token rates (input / cache-read /
 * cache-write / output) plus provenance (source_url + priced_at, the date
 * the rate was last checked) and an optional note (e.g. subscription
 * models carry no metered rate — tokens only). Seeded on first boot from
 * cost.ts's built-in list (ON CONFLICT DO NOTHING); operator edits win.
 *
 * cost.ts priceFor() consults this table (via a 30s snapshot) before its
 * hardcoded seeds, so price corrections take effect without a restart.
 */
export const MODEL_PRICING_SQL = `
CREATE TABLE IF NOT EXISTS model_pricing (
  model              TEXT PRIMARY KEY,
  input_per_1m       DOUBLE PRECISION NOT NULL DEFAULT 0,
  cached_input_per_1m DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_write_per_1m DOUBLE PRECISION NOT NULL DEFAULT 0,
  output_per_1m      DOUBLE PRECISION NOT NULL DEFAULT 0,
  note               TEXT,
  source_url         TEXT,
  priced_at          DATE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

export function modelPricingChecksum(): string {
  return createHash('sha256').update(MODEL_PRICING_SQL).digest('hex')
}
