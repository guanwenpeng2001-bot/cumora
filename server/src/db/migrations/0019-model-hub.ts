import { createHash } from 'node:crypto'

export const MODEL_HUB_SQL = `
CREATE TABLE model_sources (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('sub2api','env','byoa')),
 scope_company_id TEXT, computer_id TEXT, config JSONB NOT NULL DEFAULT '{}',
 enabled BOOLEAN NOT NULL DEFAULT TRUE, revision TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK ((kind = 'byoa') = (computer_id IS NOT NULL))
);
CREATE UNIQUE INDEX model_sources_computer ON model_sources(computer_id) WHERE kind = 'byoa';
CREATE TABLE model_definitions (
 id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, publisher_id TEXT, canonical_name TEXT NOT NULL,
 display_name TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}', UNIQUE(provider_id, canonical_name)
);
CREATE TABLE model_offerings (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES model_sources(id), model_id TEXT NOT NULL REFERENCES model_definitions(id),
 platform TEXT NOT NULL, request_model TEXT NOT NULL, protocol TEXT NOT NULL, scope_key TEXT NOT NULL,
 capabilities JSONB NOT NULL DEFAULT '[]', features JSONB NOT NULL DEFAULT '{}', limits JSONB NOT NULL DEFAULT '{}',
 engine TEXT, profile TEXT, enabled BOOLEAN NOT NULL DEFAULT TRUE, discovery_state JSONB NOT NULL DEFAULT '{}',
 metadata_origin TEXT NOT NULL, observed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, revision TEXT NOT NULL,
 UNIQUE(source_id, scope_key, platform, request_model, protocol),
 UNIQUE(id, source_id, scope_key, platform, protocol)
);
CREATE TABLE model_aliases (
 source_id TEXT NOT NULL, scope_key TEXT NOT NULL, platform TEXT NOT NULL, alias TEXT NOT NULL, protocol TEXT NOT NULL,
 offering_id TEXT NOT NULL,
 PRIMARY KEY(source_id, scope_key, platform, alias, protocol),
 FOREIGN KEY(offering_id, source_id, scope_key, platform, protocol)
 REFERENCES model_offerings(id, source_id, scope_key, platform, protocol)
);
CREATE TABLE model_bindings (
 id TEXT PRIMARY KEY, scope_type TEXT NOT NULL CHECK (scope_type IN ('server','company','computer','agent')),
 scope_id TEXT NOT NULL, domain TEXT NOT NULL CHECK (domain IN ('server','managed','byoa')),
 slot TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', targets JSONB NOT NULL, parameters JSONB NOT NULL DEFAULT '{}',
 fallback_policy TEXT NOT NULL, revision TEXT NOT NULL,
 UNIQUE(scope_type, scope_id, domain, slot, purpose)
);
CREATE TABLE model_credentials (
 id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES model_sources(id),
 platform TEXT NOT NULL, remote_user_id BIGINT, key_id BIGINT, secret_ref TEXT NOT NULL,
 status TEXT NOT NULL, revision TEXT NOT NULL, integration_owner TEXT NOT NULL,
 UNIQUE(owner_user_id, source_id, platform)
);
`
export function modelHubChecksum(): string { return createHash('sha256').update(MODEL_HUB_SQL).digest('hex') }
