/**
 * Server-wide model settings — runtime-editable, no restart.
 *
 * Storage: `server_settings` key-value table (migration 0007). Read side
 * is a sync in-memory snapshot with a 30s refresh; writes commit atomically
 * and install a complete versioned snapshot before returning. Every key falls back to its env var when the
 * DB has no row (fresh installs, or a pod that booted before the first
 * refresh landed), so behavior without the table is exactly the pre-DB
 * behavior.
 *
 * Roles: brain (agent main turn) / support (cerebellum gates) /
 * compaction (context compaction) / image / audio / embed. Text roles
 * additionally carry reasoning effort + output cap + an ordered fallback
 * chain; image/audio carry fallback chains. Embed carries NO fallback —
 * switching embedding models changes the vector space, so a silent
 * fallback would corrupt semantic memory recall (see fallback.ts).
 */
import type { PoolClient, QueryConfig } from 'pg'
import { pool } from './db/pool.js'
import { env, resolveDirectLlmEnv } from './env.js'
import type { ByoaPolicyValues } from './agents/computer/runtime-policy.js'
import type { CompactionPolicy } from './agents/turn-compaction.js'
import { parseApiKeyMap, sub2apiOpenAIBaseURL } from './sub2api.js'
import { DIRECT_LLM_SLOTS, getManagedPodSettings, installManagedPodSettings, type ManagedPodSettings } from './managed-pod-settings.js'

export interface SettingDef {
  key: string
  type: 'model' | 'list' | 'string' | 'integer' | 'reasoning' | 'json' | 'boolean' | 'number'
  required?: boolean
  pod?: boolean
  scope?: 'managed' | 'server' | 'byoa'
  effect?: 'next-turn' | 'next-gate' | 'next-tick' | 'next-admission' | 'next-create' | 'restart' | 'restart-next-create' | 'fixed' | 'pending-T41'
  unit?: 'ratio' | 'bytes' | 'pairs' | 'characters' | 'hops' | 'milliseconds'
  readOnly?: boolean
  envOnly?: boolean
  defaultValue?: string
  allowedValues?: readonly string[]
  min?: number
  max?: number
  description?: string
  /** Environment inputs, before env.ts applies defaults. */
  envKeys?: readonly string[]
  /** Env fallback when the DB has no row. */
  envValue: () => string
}

/** The full key inventory. Values are always stored as strings; list-typed
 *  keys are comma-separated. */
export const SETTING_DEFS: readonly SettingDef[] = [
  { key: 'llm_config', pod: true, type: 'json', envKeys: ['CUMORA_LLM_CONFIG'], envValue: () => process.env.CUMORA_LLM_CONFIG ?? '' },
  { key: 'sub2api_group_config', type: 'json', envValue: () => '' },
  { key: 'brain_model', pod: true, type: 'model', required: true, envKeys: ['OPENAI_MODEL'], envValue: () => env.OPENAI_MODEL ?? '' },
  { key: 'brain_fallback_models', pod: true, type: 'list', envValue: () => '' },
  { key: 'support_model', pod: true, type: 'model', required: true, envKeys: ['OPENAI_MODEL_SUPPORT'], envValue: () => env.OPENAI_MODEL_SUPPORT ?? '' },
  { key: 'support_fallback_models', pod: true, type: 'list', envValue: () => '' },
  { key: 'compaction_model', pod: true, type: 'model', required: true, envKeys: ['OPENAI_COMPACTION_MODEL', 'OPENAI_MODEL_SUPPORT'], envValue: () => env.OPENAI_COMPACTION_MODEL ?? '' },
  { key: 'compaction_fallback_models', pod: true, type: 'list', envValue: () => '' },
  { key: 'image_model', pod: true, type: 'model', required: true, envKeys: ['OPENAI_IMAGE_MODEL'], envValue: () => env.OPENAI_IMAGE_MODEL ?? '' },
  { key: 'image_fallback_models', pod: true, type: 'list', envKeys: ['OPENAI_IMAGE_FALLBACK_MODELS'], envValue: () => process.env.OPENAI_IMAGE_FALLBACK_MODELS ?? '' },
  { key: 'audio_model', pod: true, type: 'model', required: true, envKeys: ['OPENAI_AUDIO_MODEL'], envValue: () => process.env.OPENAI_AUDIO_MODEL ?? '' },
  { key: 'audio_fallback_models', pod: true, type: 'list', envKeys: ['OPENAI_AUDIO_FALLBACK_MODELS'], envValue: () => process.env.OPENAI_AUDIO_FALLBACK_MODELS ?? '' },
  { key: 'embed_model', pod: true, type: 'model', required: true, envKeys: ['OPENAI_EMBED_MODEL'], envValue: () => process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small' },
  { key: 'agent_reasoning_effort', pod: true, type: 'reasoning', envKeys: ['CUMORA_REASONING_EFFORT'], envValue: () => process.env.CUMORA_REASONING_EFFORT ?? 'low' },
  { key: 'agent_max_output_tokens', pod: true, type: 'integer', envKeys: ['CUMORA_AGENT_MAX_OUTPUT_TOKENS'], envValue: () => process.env.CUMORA_AGENT_MAX_OUTPUT_TOKENS ?? '4000' },
  { key: 'support_reasoning_effort', pod: true, type: 'reasoning', envKeys: ['CUMORA_SUPPORT_REASONING_EFFORT'], envValue: () => process.env.CUMORA_SUPPORT_REASONING_EFFORT ?? 'low' },
  { key: 'support_reasoning_headroom', pod: true, type: 'integer', envKeys: ['CUMORA_SUPPORT_REASONING_HEADROOM'], envValue: () => process.env.CUMORA_SUPPORT_REASONING_HEADROOM ?? '0' },
  { key: 'auto_compaction_enabled', pod: true, defaultValue: 'true', type: 'boolean', scope: 'managed', effect: 'next-turn', envValue: () => 'true' },
  { key: 'compaction_soft_ratio', pod: true, defaultValue: '0.75', type: 'number', scope: 'managed', effect: 'next-turn', unit: 'ratio', envValue: () => '0.75' },
  { key: 'compaction_hard_ratio', pod: true, defaultValue: '0.95', type: 'number', scope: 'managed', effect: 'next-turn', unit: 'ratio', envValue: () => '0.95' },
  { key: 'compaction_output_bytes', pod: true, defaultValue: '600', type: 'integer', min: 1, scope: 'managed', effect: 'next-turn', unit: 'bytes', envValue: () => '600', description: 'UTF-8 output prefix bytes; truncation marker is additional.' },
  { key: 'compaction_keep_recent_pairs', pod: true, defaultValue: '2', type: 'integer', min: 0, scope: 'managed', effect: 'next-turn', unit: 'pairs', envValue: () => '2' },
  { key: 'compaction_strategy', pod: true, defaultValue: 'summary', type: 'string', allowedValues: ['summary', 'drop-and-marker'], scope: 'managed', effect: 'next-turn', envValue: () => 'summary' },
  { key: 'compaction_stream_timeout_ms', pod: true, defaultValue: '30000', type: 'integer', min: 1, max: 2147483647, scope: 'managed', effect: 'next-turn', unit: 'milliseconds', envValue: () => '30000', description: 'Independent stream consumption deadline for compaction, completion verification and steer summaries; cannot be disabled.' },
  { key: 'compaction_summary_max_chars', pod: true, defaultValue: '4000', type: 'integer', min: 1, scope: 'managed', effect: 'next-turn', unit: 'characters', envValue: () => '4000' },
  { key: 'agent_max_hops', pod: true, defaultValue: '200', type: 'integer', min: 1, scope: 'managed', effect: 'next-turn', unit: 'hops', envValue: () => '200', description: 'Main turn hops; fallback attempts do not consume additional hops.' },
  { key: 'agent_turn_timeout_ms', pod: true, defaultValue: '0', type: 'integer', min: 0, max: 2147483647, scope: 'managed', effect: 'next-turn', unit: 'milliseconds', envValue: () => '0', description: 'Managed turn only; 0 disables the turn deadline. BYOA retains its local CUMORA_TURN_TIMEOUT_MS and engine behavior.' },
  { key: 'idle_enabled', type: 'boolean', defaultValue: 'true', scope: 'server', effect: 'next-tick', envKeys: ['ENABLE_IDLE'], envValue: () => process.env.ENABLE_IDLE ?? 'true' },
  { key: 'idle_interval_ms', type: 'integer', defaultValue: '900000', min: 0, max: 2147483647, unit: 'milliseconds', scope: 'server', effect: 'next-tick', envKeys: ['IDLE_INTERVAL_MS'], envValue: () => process.env.IDLE_INTERVAL_MS ?? '900000' },
  { key: 'idle_min_quiet_min', type: 'integer', defaultValue: '25', min: 0, max: 525600, scope: 'server', effect: 'next-tick', envKeys: ['IDLE_MIN_QUIET_MIN'], envValue: () => process.env.IDLE_MIN_QUIET_MIN ?? '25' },
  { key: 'agenda_gate_enabled', type: 'boolean', defaultValue: 'true', scope: 'server', effect: 'next-gate', description: 'Disabled stops automatic agenda decisions; human messages, calendar delivery and manual briefs remain enabled.', envValue: () => 'true' },
  { key: 'agenda_error_mode', type: 'string', defaultValue: 'defer', allowedValues: ['defer'], scope: 'server', effect: 'next-gate', description: 'Classifier errors defer without a brain wake or acknowledgement.', envValue: () => 'defer' },
  { key: 'scanner_enabled', type: 'boolean', defaultValue: 'true', scope: 'server', effect: 'next-tick', envKeys: ['ENABLE_SCANNER'], envValue: () => process.env.ENABLE_SCANNER ?? 'true' },
  { key: 'scanner_interval_ms', type: 'integer', defaultValue: '90000', min: 0, max: 2147483647, unit: 'milliseconds', scope: 'server', effect: 'next-tick', envKeys: ['SCANNER_INTERVAL_MS'], envValue: () => process.env.SCANNER_INTERVAL_MS ?? '90000' },
  { key: 'scanner_min_messages', type: 'integer', defaultValue: '8', min: 1, max: 80, scope: 'server', effect: 'next-tick', envValue: () => '8' },
  { key: 'scanner_window_hours', type: 'integer', defaultValue: '24', min: 1, max: 8760, scope: 'server', effect: 'next-tick', envValue: () => '24' },
  { key: 'steer_enabled', type: 'boolean', defaultValue: 'true', pod: true, scope: 'managed', effect: 'next-turn', description: 'Disables mid-turn injection only; durable messages remain available to the next turn.', envKeys: ['STEER_ENABLED'], envValue: () => (env.STEER_ENABLED ? 'true' : 'false') },
  { key: 'byoa_big_brain_concurrency', type: 'integer', defaultValue: '6', min: 1, max: 2147483647, scope: 'byoa', effect: 'next-gate', envKeys: ['CUMORA_BYOA_MAX_CONCURRENT_BIG_BRAIN'], envValue: () => process.env.CUMORA_BYOA_MAX_CONCURRENT_BIG_BRAIN ?? '6' },
  { key: 'byoa_triage_concurrency', type: 'integer', defaultValue: '8', min: 1, max: 2147483647, scope: 'byoa', effect: 'next-gate', envKeys: ['CUMORA_BYOA_MAX_CONCURRENT_TRIAGE'], envValue: () => process.env.CUMORA_BYOA_MAX_CONCURRENT_TRIAGE ?? '8' },
  { key: 'byoa_spawn_interval_ms', type: 'integer', defaultValue: '500', min: 0, max: 2147483647, unit: 'milliseconds', scope: 'byoa', effect: 'next-gate', envKeys: ['CUMORA_BYOA_MIN_SPAWN_INTERVAL_MS'], envValue: () => process.env.CUMORA_BYOA_MIN_SPAWN_INTERVAL_MS ?? '500' },
  { key: 'byoa_triage_backoff_base_ms', type: 'integer', defaultValue: '30000', min: 1, max: 2147483647, unit: 'milliseconds', scope: 'byoa', effect: 'next-gate', envValue: () => '30000' },
  { key: 'byoa_triage_backoff_max_ms', type: 'integer', defaultValue: '600000', min: 1, max: 2147483647, unit: 'milliseconds', scope: 'byoa', effect: 'next-gate', envValue: () => '600000' },
  { key: 'byoa_group_steer_enabled', type: 'boolean', defaultValue: 'true', scope: 'byoa', effect: 'next-gate', description: 'Discovered on the 30s BYOA heartbeat; applied after active spawns finish. Resources sync separately every 60s.', envKeys: ['CUMORA_BYOA_STEER_GROUP'], envValue: () => process.env.CUMORA_BYOA_STEER_GROUP ?? 'true' },
  { key: 'byoa_group_steer_interval_ms', type: 'integer', defaultValue: '8000', min: 0, max: 2147483647, unit: 'milliseconds', scope: 'byoa', effect: 'next-gate', description: 'Discovered on the 30s BYOA heartbeat; applied after active spawns finish. Resources sync separately every 60s.', envKeys: ['CUMORA_BYOA_STEER_GROUP_INTERVAL_MS'], envValue: () => process.env.CUMORA_BYOA_STEER_GROUP_INTERVAL_MS ?? '8000' },
  { key: 'synthetic_gate_enabled', type: 'boolean', defaultValue: 'true', pod: true, scope: 'managed', effect: 'next-gate', description: 'Disabled suppresses synthetic wakes; never bypasses the gate.', envValue: () => 'true' },
  { key: 'synthetic_gate_failure_mode', type: 'string', defaultValue: 'closed', pod: true, readOnly: true, allowedValues: ['closed'], scope: 'managed', effect: 'next-gate', description: 'Safety floor: no brain wake and no inbox acknowledgement on failure.', envValue: () => 'closed' },
  { key: 'triage_rate_limit_mode', type: 'string', defaultValue: 'closed', pod: true, readOnly: true, allowedValues: ['closed'], scope: 'managed', effect: 'next-gate', description: 'Safety floor: no brain wake and no inbox acknowledgement on failure.', envValue: () => 'closed' },
  { key: 'inbox_triage_failure_mode', type: 'string', defaultValue: 'defer', pod: true, allowedValues: ['defer'], scope: 'managed', effect: 'next-gate', envValue: () => 'defer' },
  { key: 'cloud_inbox_triage_timeout_ms', type: 'integer', defaultValue: '8000', min: 1, max: 2147483647, unit: 'milliseconds', pod: true, scope: 'managed', effect: 'next-gate', envValue: () => '8000' },
  { key: 'synthetic_gate_timeout_ms', type: 'integer', defaultValue: '8000', min: 1, max: 2147483647, unit: 'milliseconds', pod: true, scope: 'managed', effect: 'next-gate', envValue: () => '8000' },
  { key: 'byoa_triage_timeout_ms', type: 'integer', defaultValue: '30000', min: 1, max: 2147483647, unit: 'milliseconds', scope: 'byoa', effect: 'next-gate', description: 'Discovered on the 30s BYOA heartbeat; applied after active spawns finish. Resources sync separately every 60s.', envValue: () => '30000' },
  { key: 'triage_backoff_base_ms', type: 'integer', defaultValue: '30000', min: 1, max: 2147483647, unit: 'milliseconds', pod: true, scope: 'managed', effect: 'next-gate', envValue: () => '30000' },
  { key: 'triage_backoff_max_ms', type: 'integer', defaultValue: '60000', min: 1, max: 2147483647, unit: 'milliseconds', pod: true, scope: 'managed', effect: 'next-gate', envValue: () => '60000' },
  { key: 'support_inbox_triage_output_tokens', type: 'integer', defaultValue: '2000', min: 1, max: 1000000, pod: true, scope: 'managed', effect: 'next-gate', description: 'Base output tokens; support reasoning headroom is added once.', envValue: () => '2000' },
  { key: 'support_synthetic_gate_output_tokens', type: 'integer', defaultValue: '300', min: 1, max: 1000000, pod: true, scope: 'managed', effect: 'next-gate', description: 'Base output tokens; support reasoning headroom is added once.', envValue: () => '300' },
  { key: 'low_priority_wake_budget_per_minute', type: 'integer', defaultValue: '20', min: 1, max: 1000000, scope: 'server', effect: 'next-gate', envValue: () => '20' },
  { key: 'agent_turn_rate_per_minute', type: 'integer', defaultValue: '30', min: 1, max: 1000000, scope: 'server', effect: 'next-gate', envValue: () => '30' },
  { key: 'pod_admission_enabled', type: 'boolean', defaultValue: 'true', scope: 'server', readOnly: true, allowedValues: ['true'], effect: 'fixed', envValue: () => 'true' },
  { key: 'pod_capacity_unknown_mode', type: 'string', defaultValue: 'closed', scope: 'server', readOnly: true, allowedValues: ['closed'], effect: 'fixed', envValue: () => 'closed' },
  { key: 'pod_assignment_policy', type: 'string', defaultValue: 'deny', scope: 'server', readOnly: true, allowedValues: ['deny'], effect: 'fixed', description: 'Invalid placement is always denied; tenant and assignment verification cannot be disabled.', envValue: () => 'deny' },
  { key: 'pod_admission_max', type: 'integer', defaultValue: '40', scope: 'server', min: 0, max: 1000000, effect: 'next-admission', description: '0 retains the cluster capacity ceiling only. Changes never cancel admitted work.', envKeys: ['AGENT_POD_ADMISSION_MAX'], envValue: () => String(env.AGENT_POD_ADMISSION_MAX ?? 40) },
  { key: 'pod_fuse_threshold', type: 'number', defaultValue: '0.90', scope: 'server', effect: 'next-admission', unit: 'ratio', description: 'Admission stops at this ratio of the effective cap; existing Pods are not cancelled.', envValue: () => '0.90' },
  { key: 'pod_gc_enabled', type: 'boolean', defaultValue: 'true', scope: 'server', effect: 'next-tick', envKeys: ['ENABLE_AGENT_POD_GC'], envValue: () => process.env.ENABLE_AGENT_POD_GC === 'false' ? 'false' : 'true' },
  { key: 'chrome_pvc_gc_enabled', type: 'boolean', defaultValue: 'true', scope: 'server', effect: 'next-tick', envKeys: ['ENABLE_CHROME_PVC_GC'], envValue: () => process.env.ENABLE_CHROME_PVC_GC === 'false' ? 'false' : 'true' },
  { key: 'cluster_monitor_enabled', type: 'boolean', defaultValue: 'true', scope: 'server', effect: 'next-tick', envKeys: ['ENABLE_CLUSTER_MONITOR'], envValue: () => process.env.ENABLE_CLUSTER_MONITOR === 'false' ? 'false' : 'true' },
  { key: 'agent_run_sweeper_enabled', type: 'boolean', defaultValue: 'true', scope: 'server', effect: 'next-tick', envKeys: ['ENABLE_AGENT_RUN_SWEEPER'], envValue: () => process.env.ENABLE_AGENT_RUN_SWEEPER === 'false' ? 'false' : 'true' },
  { key: 'cluster_monitor_pending_min', type: 'integer', defaultValue: '20', scope: 'server', effect: 'next-tick', min: 1, max: 2147483647, envValue: () => '20' },
  { key: 'cluster_monitor_ratio_min', type: 'number', defaultValue: '0.95', scope: 'server', effect: 'next-tick', unit: 'ratio', envValue: () => '0.95' },
  { key: 'cluster_monitor_sustained_ms', type: 'integer', defaultValue: '300000', scope: 'server', effect: 'next-tick', min: 1, max: 2147483647, unit: 'milliseconds', envValue: () => '300000' },
  { key: 'cluster_monitor_alert_cooldown_ms', type: 'integer', defaultValue: '1800000', scope: 'server', effect: 'next-tick', min: 1, max: 2147483647, unit: 'milliseconds', envValue: () => '1800000' },
  { key: 'pod_gc_interval_ms', type: 'integer', defaultValue: '60000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', description: '0 pauses future ticks; in-flight work completes without re-entry.', envValue: () => '60000' },
  { key: 'cluster_monitor_interval_ms', type: 'integer', defaultValue: '60000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', description: '0 pauses future ticks; in-flight work completes without re-entry.', envValue: () => '60000' },
  { key: 'agent_run_sweeper_interval_ms', type: 'integer', defaultValue: '60000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', description: '0 pauses future ticks; in-flight work completes without re-entry.', envValue: () => '60000' },
  { key: 'email_retry_interval_ms', type: 'integer', defaultValue: '60000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', envKeys: ['EMAIL_RETRY_INTERVAL_MS'], envValue: () => process.env.EMAIL_RETRY_INTERVAL_MS ?? '60000' },
  { key: 'email_gc_interval_ms', type: 'integer', defaultValue: '86400000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', envKeys: ['EMAIL_GC_INTERVAL_MS'], envValue: () => process.env.EMAIL_GC_INTERVAL_MS ?? '86400000' },
  { key: 'db_gc_interval_ms', type: 'integer', defaultValue: '300000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', envKeys: ['DB_GC_INTERVAL_MS'], envValue: () => process.env.DB_GC_INTERVAL_MS ?? '300000' },
  { key: 'workspace_cleanup_interval_ms', type: 'integer', defaultValue: '60000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', envKeys: ['WORKSPACE_CLEANUP_INTERVAL_MS'], envValue: () => process.env.WORKSPACE_CLEANUP_INTERVAL_MS ?? '60000' },
  { key: 'poll_sweep_interval_ms', type: 'integer', defaultValue: '60000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', envKeys: ['POLL_SWEEP_INTERVAL_MS'], envValue: () => process.env.POLL_SWEEP_INTERVAL_MS ?? '60000' },
  { key: 'llm_rollup_interval_ms', type: 'integer', defaultValue: '120000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', envKeys: ['LLM_ROLLUP_INTERVAL_MS'], envValue: () => process.env.LLM_ROLLUP_INTERVAL_MS ?? '120000' },
  { key: 'db_gc_batch', type: 'integer', defaultValue: '10000', scope: 'server', min: 1, max: 1000000, effect: 'next-tick', envKeys: ['DB_GC_BATCH'], envValue: () => process.env.DB_GC_BATCH ?? '10000' },
  { key: 'db_gc_ws_tickets_days', type: 'integer', defaultValue: '1', scope: 'server', min: 0, max: 365000, effect: 'next-tick', envKeys: ['DB_GC_WS_TICKETS_DAYS'], envValue: () => process.env.DB_GC_WS_TICKETS_DAYS ?? '1' },
  { key: 'db_gc_agent_log_days', type: 'integer', defaultValue: '30', scope: 'server', min: 0, max: 365000, effect: 'next-tick', envKeys: ['DB_GC_AGENT_LOG_DAYS'], envValue: () => process.env.DB_GC_AGENT_LOG_DAYS ?? '30' },
  { key: 'db_gc_agent_events_days', type: 'integer', defaultValue: '30', scope: 'server', min: 0, max: 365000, effect: 'next-tick', envKeys: ['DB_GC_AGENT_EVENTS_DAYS'], envValue: () => process.env.DB_GC_AGENT_EVENTS_DAYS ?? '30' },
  { key: 'db_gc_agent_runs_days', type: 'integer', defaultValue: '30', scope: 'server', min: 0, max: 365000, effect: 'next-tick', envKeys: ['DB_GC_AGENT_RUNS_DAYS'], envValue: () => process.env.DB_GC_AGENT_RUNS_DAYS ?? '30' },
  { key: 'db_gc_llm_calls_days', type: 'integer', defaultValue: '90', scope: 'server', min: 0, max: 365000, effect: 'next-tick', envKeys: ['DB_GC_LLM_CALLS_DAYS'], envValue: () => process.env.DB_GC_LLM_CALLS_DAYS ?? '90' },
  { key: 'workspace_cleanup_batch', type: 'integer', defaultValue: '8', scope: 'server', min: 1, max: 32, effect: 'next-tick', envKeys: ['WORKSPACE_CLEANUP_BATCH'], envValue: () => process.env.WORKSPACE_CLEANUP_BATCH ?? '8' },
  { key: 'workspace_cleanup_retention_days', type: 'integer', defaultValue: '7', scope: 'server', min: 0, max: 365000, effect: 'next-tick', envKeys: ['WORKSPACE_CLEANUP_RETENTION_DAYS'], envValue: () => process.env.WORKSPACE_CLEANUP_RETENTION_DAYS ?? '7' },
  { key: 'llm_rollup_retention_hours', type: 'integer', defaultValue: '2280', scope: 'server', min: 0, max: 8760000, effect: 'next-tick', envKeys: ['LLM_ROLLUP_RETENTION_HOURS'], envValue: () => process.env.LLM_ROLLUP_RETENTION_HOURS ?? '2280' },
  { key: 'agent_run_stale_age_ms', type: 'integer', defaultValue: '600000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', envKeys: ['AGENT_RUN_STALE_AGE_MS'], envValue: () => process.env.AGENT_RUN_STALE_AGE_MS ?? '600000' },
  { key: 'workspace_runtime_cleanup_enabled', type: 'boolean', defaultValue: 'false', scope: 'server', effect: 'next-tick', envKeys: ['WORKSPACE_RUNTIME_CLEANUP_ENABLED'], envValue: () => process.env.WORKSPACE_RUNTIME_CLEANUP_ENABLED ?? 'false' },
  { key: 'chrome_pvc_gc_interval_ms', type: 'integer', defaultValue: '3600000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-tick', description: '0 pauses future ticks; in-flight work completes without re-entry.', envKeys: ['CHROME_PVC_GC_INTERVAL_MS'], envValue: () => String(env.CHROME_PVC_GC_INTERVAL_MS ?? 3600000) },
  { key: 'chrome_pvc_gc_idle_days', type: 'integer', defaultValue: '30', scope: 'server', min: 0, max: 365000, effect: 'next-tick', envKeys: ['CHROME_PVC_GC_IDLE_DAYS'], envValue: () => String(env.CHROME_PVC_GC_IDLE_DAYS ?? 30) },
  { key: 'pod_idle_ms', type: 'integer', defaultValue: '180000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-create', envKeys: ['AGENT_IDLE_MS'], envValue: () => String(env.AGENT_IDLE_MS ?? 180000) },
  { key: 'pod_no_work_ms', type: 'integer', defaultValue: '90000', scope: 'server', min: 0, max: 2147483647, unit: 'milliseconds', effect: 'next-create', envKeys: ['AGENT_NO_WORK_MS'], envValue: () => String(env.AGENT_NO_WORK_MS ?? 90000) },
  { key: 'wake_fanout_concurrency', type: 'integer', defaultValue: '6', scope: 'server', readOnly: true, envOnly: true, effect: 'restart', description: 'Env-managed process semaphore; change the deployment env and restart. DB writes are unsupported.', envKeys: ['WAKE_FANOUT_CONCURRENCY'], envValue: () => String(env.WAKE_FANOUT_CONCURRENCY ?? 6) },
  { key: 'kubectl_max_concurrency', type: 'integer', defaultValue: '8', scope: 'server', readOnly: true, envOnly: true, effect: 'restart', description: 'Env-managed process semaphore; change the deployment env and restart. DB writes are unsupported.', envKeys: ['KUBECTL_MAX_CONCURRENCY'], envValue: () => String(env.KUBECTL_MAX_CONCURRENCY ?? 8) },
  { key: 'chrome_profile_pvc_enabled', type: 'boolean', defaultValue: 'true', scope: 'server', readOnly: true, envOnly: true, effect: 'restart-next-create', description: 'Deployment env; restart before next Pod/PVC creation. Existing storage requires a separate migration, not a hot settings update.', envKeys: ['CUMORA_CHROME_PROFILE_PVC'], envValue: () => process.env.CUMORA_CHROME_PROFILE_PVC === 'false' ? 'false' : 'true' },
  { key: 'chrome_pvc_size', type: 'string', defaultValue: '500Mi', scope: 'server', readOnly: true, envOnly: true, effect: 'restart-next-create', description: 'Deployment env; restart before next Pod/PVC creation. Existing storage requires a separate migration, not a hot settings update.', envKeys: ['CUMORA_CHROME_PVC_SIZE'], envValue: () => process.env.CUMORA_CHROME_PVC_SIZE ?? '500Mi' },
  { key: 'chrome_pvc_storage_class', type: 'string', defaultValue: '', scope: 'server', readOnly: true, envOnly: true, effect: 'restart-next-create', description: 'Deployment env; restart before next Pod/PVC creation. Existing storage requires a separate migration, not a hot settings update.', envKeys: ['CUMORA_CHROME_PVC_STORAGECLASS'], envValue: () => process.env.CUMORA_CHROME_PVC_STORAGECLASS ?? '' },
  // Not a model — the skills tab's local hub directory.
  { key: 'local_skillhub_path', type: 'string', envKeys: ['LOCAL_SKILLHUB_PATH'], envValue: () => process.env.LOCAL_SKILLHUB_PATH ?? '' },
]

const KNOWN_KEYS = new Set(SETTING_DEFS.map((d) => d.key))

/** Exported for the HTTP layer's 400 validation; writeServerSettings
 *  re-checks as defense in depth. */
export const KNOWN_SETTING_KEYS: ReadonlySet<string> = KNOWN_KEYS

const REFRESH_MS = 30_000
const REFRESH_FAILURE_BACKOFF_MS = 5_000

const REVISION_KEY = '__settings_revision'
const INHERIT_PREFIX = '__settings_inherit:'

export interface ServerSettingsSnapshot {
  /** Decimal string: preserves PostgreSQL bigint precision across JSON. */
  revision: string
  settings: Readonly<Record<string, string>>
  sources: Readonly<Record<string, 'db' | 'env' | 'default'>>
  inheritedSources?: Readonly<Record<string, 'env' | 'default'>>
  definitions?: readonly Readonly<Omit<SettingDef, 'envValue' | 'envKeys'>>[]
  diagnostics?: readonly string[]
  source?: 'db' | 'env' | 'bootstrap'
}

let settingsContext: import('node:async_hooks').AsyncLocalStorage<ServerSettingsSnapshot> | undefined

export async function withServerSettingsSnapshot<T>(work: () => T | Promise<T>): Promise<T> {
  const captured = getServerSettingsSnapshot()
  const { AsyncLocalStorage } = await import('node:async_hooks')
  settingsContext ??= new AsyncLocalStorage<ServerSettingsSnapshot>()
  return settingsContext.run(captured, work)
}

let snapshot: ServerSettingsSnapshot | null = null
let snapshotAt = 0
let lastRefreshFailureAt = 0
let refreshing: Promise<void> | null = null
let generation = 0
let writing: Promise<unknown> = Promise.resolve()

function makeSnapshot(rows: { key: string; value: string }[], defaults?: Readonly<Record<string, string>>, defaultSources?: ServerSettingsSnapshot['inheritedSources']): ServerSettingsSnapshot {
  const values = new Map(rows.map((r) => [r.key, r.value]))
  const revision = values.get(REVISION_KEY) ?? '0'
  if (!/^\d+$/.test(revision)) throw new Error('invalid settings revision')
  const diagnostics: string[] = []
  const settings: Record<string, string> = {}
  const sources: Record<string, 'db' | 'env' | 'default'> = {}
  const inheritedSources: Record<string, 'env' | 'default'> = {}
  for (const def of SETTING_DEFS) {
    const fallback = defaults ? defaults[def.key] ?? def.defaultValue ?? '' : settingEnvValue(def, diagnostics)
    const fallbackSource = defaultSources?.[def.key] ?? (!def.envKeys?.some(key => def.key === 'embed_model' ? Boolean(process.env[key]) : process.env[key] !== undefined)
      || diagnostics.includes(`invalid-env-setting:${def.key}`) ? 'default' : 'env')
    inheritedSources[def.key] = fallbackSource
    settings[def.key] = def.envOnly ? fallback : values.get(def.key) ?? fallback
    sources[def.key] = !def.envOnly && values.has(def.key) ? 'db' : fallbackSource
    if (def.envOnly && values.has(def.key) && values.get(def.key) !== fallback) diagnostics.push(`ignored-db-setting:${def.key}`)
    try { validateServerSettings({ [def.key]: settings[def.key] }, true) } catch {
      diagnostics.push(`invalid-setting:${def.key}`)
      console.warn('[settings] invalid value; using env/default', def.key)
      settings[def.key] = fallback
      sources[def.key] = fallbackSource
      try { validateServerSettings({ [def.key]: settings[def.key] }, true) } catch {
        settings[def.key] = def.defaultValue ?? ''
        sources[def.key] = 'default'
      }
    }
  }
  if (!(Number(settings.compaction_soft_ratio) < Number(settings.compaction_hard_ratio))) {
    diagnostics.push('invalid-setting:compaction-ratios')
    console.warn('[settings] invalid compaction ratios; using defaults')
    settings.compaction_soft_ratio = '0.75'
    settings.compaction_hard_ratio = '0.95'
    sources.compaction_soft_ratio = sources.compaction_hard_ratio = 'default'
  }
  if (Number(settings.triage_backoff_base_ms) > Number(settings.triage_backoff_max_ms)) {
    diagnostics.push('invalid-setting:triage-backoff')
    console.warn('[settings] invalid triage backoff; using defaults')
    settings.triage_backoff_base_ms = '30000'
    settings.triage_backoff_max_ms = '60000'
    sources.triage_backoff_base_ms = sources.triage_backoff_max_ms = 'default'
  }
  const definitions = Object.freeze(SETTING_DEFS.map(({ envValue: _envValue, envKeys: _envKeys, ...def }) => Object.freeze(def)))
  if (Number(settings.byoa_triage_backoff_base_ms) > Number(settings.byoa_triage_backoff_max_ms)) {
    diagnostics.push('byoa_triage_backoff: base must not exceed maximum; using defaults')
    settings.byoa_triage_backoff_base_ms = '30000'
    settings.byoa_triage_backoff_max_ms = '600000'
    sources.byoa_triage_backoff_base_ms = sources.byoa_triage_backoff_max_ms = 'default'
  }
  return Object.freeze({ revision, definitions, source: 'db', settings: Object.freeze(settings), inheritedSources: Object.freeze(inheritedSources), sources: Object.freeze(sources), diagnostics: Object.freeze(diagnostics) })
}

function installSnapshot(next: ServerSettingsSnapshot): void {
  if (snapshot && BigInt(next.revision) < BigInt(snapshot.revision)) return
  snapshot = next
  snapshotAt = Date.now()
  lastRefreshFailureAt = 0
}

function podPolicy(policy: ServerSettingsSnapshot): ServerSettingsSnapshot {
  const allowed = SETTING_DEFS.filter(def => def.pod)
  return Object.freeze({
    revision: policy.revision, source: policy.source,
    settings: Object.freeze(Object.fromEntries(allowed.map(def => [def.key, policy.settings[def.key]]))),
    sources: Object.freeze(Object.fromEntries(allowed.map(def => [def.key, policy.sources[def.key]]))),
    inheritedSources: policy.inheritedSources && Object.freeze(Object.fromEntries(allowed.map(def => [def.key, policy.inheritedSources![def.key]]))),
    definitions: policy.definitions?.filter(def => def.pod),
    diagnostics: policy.diagnostics,
  })
}

async function readManagedPodSettings(base: ManagedPodSettings): Promise<ManagedPodSettings> {
  // One statement gives policy and owner identity the same MVCC snapshot.
  const { rows } = await pool.query<{
    settings: { key: string; value: string }[]
    owner_user_id: string; sub2api_api_key: string | null; authorization_version: string
  }>({
    text: `SELECT c.owner_user_id, u.sub2api_api_key, u.xmin::text AS authorization_version,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('key', s.key, 'value', s.value))
               FROM server_settings s WHERE s.key = ANY($3::text[])), '[]'::jsonb) AS settings
           FROM participants p JOIN companies c ON c.id = p.company_id
           JOIN users u ON u.id = c.owner_user_id
          WHERE p.id = $1 AND c.id = $2`,
    values: [base.agentId, base.gateway.companyId, [...SETTING_DEFS.filter(def => def.pod).map(def => def.key), REVISION_KEY]],
    query_timeout: 5_000,
  } as QueryConfig & { query_timeout: number })
  const row = rows[0]
  if (!row) throw new Error('Managed Pod owner identity unavailable')
  return {
    ...base, source: 'db', policy: podPolicy(makeSnapshot(row.settings, base.defaults, base.policy.inheritedSources)),
    gateway: {
      companyId: base.gateway.companyId, ownerId: row.owner_user_id, generation: 0,
      authorizationVersion: `${row.owner_user_id}:${row.authorization_version}:0:${base.gateway.baseURL}`,
      keys: parseApiKeyMap(row.sub2api_api_key), baseURL: base.gateway.baseURL,
    },
  }
}

/** Called only by the main service; runtime-only credentials stay outside public settings. */
export async function createManagedPodBootstrap(agentId: string, companyId: string, mapURL: (url: string) => string): Promise<ManagedPodSettings> {
  const base: ManagedPodSettings = {
    version: 1, agentId, source: 'bootstrap', policy: podPolicy(getServerSettingsSnapshot()),
    defaults: Object.fromEntries(SETTING_DEFS.filter(def => def.pod).map(def => [def.key, settingEnvValue(def)])),
    gateway: { companyId, ownerId: '', authorizationVersion: '', generation: 0, keys: {}, baseURL: mapURL(sub2apiOpenAIBaseURL()) },
    direct: Object.fromEntries(DIRECT_LLM_SLOTS.map(slot => {
      const direct = resolveDirectLlmEnv(slot)
      return [slot, { ...direct, baseURL: mapURL(direct.baseURL) }]
    })) as ManagedPodSettings['direct'],
  }
  // A failed owner read must not be mistaken for an unprovisioned owner.
  const next = await readManagedPodSettings(base)
  return { ...next, source: 'bootstrap', policy: { ...next.policy, source: 'bootstrap' } }
}

function installPodBootstrap(): ManagedPodSettings | null {
  let managed = getManagedPodSettings()
  if (managed && !snapshot) {
    // Older bootstraps predate the optional managed turn settings.
    const defaults = { ...managed.defaults }
    const settings = { ...managed.policy.settings }
    const sources = { ...managed.policy.sources }
    for (const def of SETTING_DEFS.filter(def => def.scope === 'managed')) {
      defaults[def.key] ??= settingEnvValue(def)
      if (settings[def.key] === undefined) {
        settings[def.key] = defaults[def.key]
        sources[def.key] = def.envKeys?.some(key => process.env[key] !== undefined) ? 'env' : 'default'
      }
    }
    managed = { ...managed, defaults, policy: { ...managed.policy, settings, sources } }
    for (const def of SETTING_DEFS.filter(def => def.pod && def.defaultValue === undefined)) {
      if (typeof managed.policy.settings[def.key] !== 'string' || typeof managed.defaults[def.key] !== 'string'
        || !['db', 'env', 'default'].includes(managed.policy.sources[def.key])) throw new Error('Incomplete managed Pod policy')
    }
    installManagedPodSettings(managed)
    const normalized = podPolicy(makeSnapshot([
      ...Object.entries(managed.policy.settings).map(([key, value]) => ({ key, value })),
      { key: REVISION_KEY, value: managed.policy.revision },
    ], managed.defaults, managed.policy.inheritedSources))
    const originalPolicy = managed.policy
    installSnapshot(Object.freeze({ ...normalized, source: managed.source,
      sources: Object.freeze(Object.fromEntries(Object.entries(normalized.sources).map(([key, source]) => [
        key, normalized.settings[key] === originalPolicy.settings[key] ? originalPolicy.sources[key] ?? source : source,
      ]))),
    }))
  }
  return managed
}

/** Install bootstrap before the first turn, then wait at most five seconds. */
export async function initializeManagedPodSettings(waitMs = 5_000): Promise<void> {
  installPodBootstrap()
  if (!snapshot) installSnapshot(Object.freeze({ ...makeSnapshot([]), source: 'env' }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([loadServerSettings(), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
  startServerSettingsRefresher()
  console.log(`[settings] Pod ready source=${snapshot!.source} revision=${snapshot!.revision}`)
}

/** Forced refreshes wait for older queries, then perform their own read. */
export async function refreshServerSettings(force = false): Promise<void> {
  const managed = installPodBootstrap()
  if (refreshing) {
    if (!force) return refreshing
    await refreshing
    return refreshServerSettings(true)
  }
  if (!force && snapshot && Date.now() - snapshotAt < REFRESH_MS) return
  if (!force && lastRefreshFailureAt && Date.now() - lastRefreshFailureAt < REFRESH_FAILURE_BACKOFF_MS) return
  const startedGeneration = generation
  refreshing = (async () => {
    try {
      if (managed) {
        const next = await readManagedPodSettings(managed)
        if (startedGeneration === generation && (!snapshot || BigInt(next.policy.revision) >= BigInt(snapshot.revision))) {
          installManagedPodSettings(next)
          installSnapshot(next.policy)
        }
      } else {
        const { rows } = await pool.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
        const next = makeSnapshot(rows)
        if (startedGeneration === generation) installSnapshot(next)
      }
    } catch {
      if (startedGeneration === generation) lastRefreshFailureAt = Date.now()
      console.warn(`[settings] refresh failed; retaining source=${snapshot?.source ?? 'env'} revision=${snapshot?.revision ?? '0'}`)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export function getServerSettingsSnapshot(): ServerSettingsSnapshot {
  const captured = settingsContext?.getStore()
  if (captured) return captured
  installPodBootstrap()
  if (!snapshot || Date.now() - snapshotAt >= REFRESH_MS) void refreshServerSettings()
  return snapshot ?? Object.freeze({ ...makeSnapshot([]), source: 'env' })
}

/** Sync read from one complete, immutable snapshot. */
export function getServerSetting(key: string): string {
  return getServerSettingsSnapshot().settings[key] ?? ''
}

/** List-typed read: comma-separated → trimmed string array. */
export function getServerSettingList(key: string): string[] {
  return getServerSetting(key).split(',').map((s) => s.trim()).filter(Boolean)
}

/** First-boot seed: copy env values into the table, never overwriting
 *  existing rows (operator edits win over later .env changes). */
export async function seedServerSettingsFromEnv(): Promise<void> {
  if (process.env.CUMORA_AGENT_ID || getManagedPodSettings()) throw new Error('Managed Pods cannot seed server settings')
  await commitSettings(async (client) => {
    await client.query(
      `INSERT INTO server_settings (key, value)
       SELECT e.key, e.value FROM jsonb_each_text($1::jsonb) e
       WHERE NOT EXISTS (SELECT 1 FROM server_settings s WHERE s.key = $2 || e.key)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(Object.fromEntries(SETTING_DEFS.filter(d => !d.envOnly).map((d) => [d.key, settingEnvValue(d)]))), INHERIT_PREFIX],
    )
  })
}

/** Main-service boot hook; Pods must use the read-only loader. */
export async function initServerSettings(): Promise<void> {
  await seedServerSettingsFromEnv()
}

export async function loadServerSettings(): Promise<void> {
  await refreshServerSettings(true)
}

/** Periodic refresh so multi-process deployments (server + pods) converge
 *  without a restart. Unref'd — never keeps a process alive. */
let refreshTimer: ReturnType<typeof setInterval> | undefined
export function startServerSettingsRefresher(): void {
  refreshTimer ??= setInterval(() => void refreshServerSettings(), REFRESH_MS)
  refreshTimer.unref()
}

// ── role model getters (sync; snapshot + env fallback) ──────────────────

export function getBrainModel(): string { return getServerSetting('brain_model') }
export function getSupportModel(): string { return getServerSetting('support_model') }
export function getCompactionModel(): string { return getServerSetting('compaction_model') }
export function getImageModel(): string { return getServerSetting('image_model') }
export function getAudioModel(): string { return getServerSetting('audio_model') }
export function getEmbedModel(): string { return getServerSetting('embed_model') }

export interface TurnBudgetPolicy extends CompactionPolicy {
  readonly maxHops: number
  readonly timeoutMs: number
  readonly revision: string
}

export function getTurnBudgetPolicy(): Readonly<TurnBudgetPolicy> {
  const { settings, revision } = getServerSettingsSnapshot()
  return Object.freeze({
    autoEnabled: settings.auto_compaction_enabled === 'true',
    softRatio: Number(settings.compaction_soft_ratio), hardRatio: Number(settings.compaction_hard_ratio),
    outputBytes: Number(settings.compaction_output_bytes), keepRecentPairs: Number(settings.compaction_keep_recent_pairs),
    strategy: settings.compaction_strategy as CompactionPolicy['strategy'],
    summaryMaxChars: Number(settings.compaction_summary_max_chars),
    maxHops: Number(settings.agent_max_hops), timeoutMs: Number(settings.agent_turn_timeout_ms), revision,
  })
}

function settingEnvValue(def: SettingDef, diagnostics?: string[]): string {
  const raw = def.envValue()
  if (def.defaultValue === undefined) return raw
  let value = raw
  if (['idle_enabled', 'scanner_enabled'].includes(def.key)) value = raw === 'false' ? 'false' : 'true'
  else if (def.key === 'byoa_group_steer_enabled') value = raw === '0' ? 'false' : 'true'
  else if (def.type === 'boolean') {
    if (/^(true|1|yes|on)$/i.test(raw)) value = 'true'
    else if (/^(false|0|no|off)$/i.test(raw)) value = 'false'
  }
  try { validateServerSettings({ [def.key]: value }, true); return value } catch {
    diagnostics?.push(`invalid-env-setting:${def.key}`)
    console.warn('[settings] invalid env value; using default', def.key)
    return def.defaultValue
  }
}

export function automationNumber(key: string): number {
  return Number(getServerSetting(key))
}

export function automationEnabled(key: string): boolean {
  return getServerSetting(key) === 'true'
}

/** The monitor survives disable/enable; an in-flight tick always owns its slot. */
export function startAutomationTimer(
  enabledKey: string, intervalKey: string, tick: () => Promise<void>,
  options: { immediate?: boolean; unref?: boolean } = {},
): NodeJS.Timeout {
  let interval = automationEnabled(enabledKey) ? automationNumber(intervalKey) : 0
  let dueAt = Date.now() + (options.immediate ? 0 : interval)
  let running = false
  const timer = setInterval(() => {
    const next = automationEnabled(enabledKey) ? automationNumber(intervalKey) : 0
    const now = Date.now()
    if (next !== interval) {
      interval = next
      dueAt = now + interval
    }
    if (interval <= 0 || running || now < dueAt) return
    running = true
    dueAt = now + interval
    void withServerSettingsSnapshot(tick).catch(e => console.error(`[${enabledKey}]`, e)).finally(() => {
      running = false
    })
  }, 100)
  if (options.unref) timer.unref()
  return timer
}

/** A stopped worker retains ownership of its in-flight tick across restarts. */
export function createOperationsWorker(
  intervalKey: string, tick: () => Promise<unknown>,
  options: { immediate?: boolean; unref?: boolean; enabledKey?: string } = {},
): { start(intervalMs?: number): NodeJS.Timeout; stop(): void; nudge(): void } {
  let timer: NodeJS.Timeout | null = null
  let running = false
  let override: number | undefined
  let interval = 0
  let dueAt = 0
  const readInterval = () => options.enabledKey && !automationEnabled(options.enabledKey)
    ? 0 : override ?? automationNumber(intervalKey)
  const run = () => {
    if (!timer || running || readInterval() <= 0) return
    running = true
    void withServerSettingsSnapshot(tick).catch(error => {
      console.error(`[${intervalKey}]`, error)
    }).finally(() => { running = false })
  }
  return {
    start(intervalMs) {
      if (timer) return timer
      override = intervalMs
      interval = readInterval()
      dueAt = Date.now() + interval
      timer = setInterval(() => {
        const next = readInterval()
        const now = Date.now()
        if (next !== interval) {
          interval = next
          dueAt = now + interval
        }
        if (interval <= 0 || running || now < dueAt) return
        dueAt = now + interval
        run()
      }, 100)
      if (options.unref) timer.unref()
      if (options.immediate) run()
      return timer
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    nudge: run,
  }
}

export class InvalidServerSettingError extends Error {}

export function validateServerSettings(entries: Record<string, unknown>, reading = false): asserts entries is Record<string, string | null> {
  for (const [key, value] of Object.entries(entries)) {
    const def = SETTING_DEFS.find((d) => d.key === key)
    if (!def) throw new InvalidServerSettingError('unknown setting key: ' + key)
    if (def.readOnly && !reading) throw new InvalidServerSettingError('read-only setting: ' + key)
    if (value === null) {
      if (def.required && !def.envValue().trim()) throw new InvalidServerSettingError('setting ' + key + ' has no inherited value')
      continue
    }
    if (typeof value !== 'string') throw new InvalidServerSettingError('setting ' + key + ' must be a string or null to inherit')
    if (def.required && !value.trim()) throw new InvalidServerSettingError('setting ' + key + ' must not be empty; use null to inherit')
    if (def.allowedValues && !def.allowedValues.includes(value)) throw new InvalidServerSettingError('invalid setting: ' + key)
    if (def.type === 'boolean' && !['true', 'false'].includes(value)) throw new InvalidServerSettingError('invalid boolean setting: ' + key)
    if (def.type === 'number' && (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value) || !(Number(value) > 0 && Number(value) < 1))) {
      throw new InvalidServerSettingError('invalid ratio setting: ' + key)
    }
    if ((def.min !== undefined && Number(value) < def.min) || (def.max !== undefined && Number(value) > def.max)) {
      throw new InvalidServerSettingError('setting out of range: ' + key)
    }
    if (def.type === 'json') {
      if (key === 'llm_config') parseLlmConfig(value, true)
      else parseGroupConfig(value, true)
    }
    if (def.type === 'integer' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (key === 'agent_max_output_tokens' && Number(value) === 0))) {
      throw new InvalidServerSettingError('invalid integer setting: ' + key)
    }
    if (def.type === 'reasoning' && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
      throw new InvalidServerSettingError('invalid reasoning setting: ' + key)
    }
  }
}

function commitSettings(mutate: (client: PoolClient) => Promise<void>): Promise<ServerSettingsSnapshot> {
  if (process.env.CUMORA_AGENT_ID || getManagedPodSettings()) return Promise.reject(new Error('Managed Pod settings are read-only'))
  const pending = writing.then(async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize all settings writers, including first-boot seed, across processes.
      await client.query('LOCK TABLE server_settings IN SHARE ROW EXCLUSIVE MODE')
      await mutate(client)
      await client.query(
        `INSERT INTO server_settings (key, value) VALUES ($1, '1')
         ON CONFLICT (key) DO UPDATE SET value = (server_settings.value::bigint + 1)::text, updated_at = NOW()`,
        [REVISION_KEY],
      )
      const { rows } = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
      const next = makeSnapshot(rows)
      await client.query('COMMIT')
      generation++
      installSnapshot(next)
      return next
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  })
  writing = pending.catch(() => {})
  return pending
}

/** Null restores inheritance; explicit empty strings remain valid only for optional values. */
export async function writeServerSettings(entries: Record<string, string | null>): Promise<ServerSettingsSnapshot> {
  validateServerSettings(entries)
  if (typeof entries.sub2api_group_config === 'string' && entries.sub2api_group_config.trim()) {
    const { validateSub2apiGroupSelection } = await import('./sub2api.js')
    await validateSub2apiGroupSelection(parseGroupConfig(entries.sub2api_group_config, true))
  }
  const rows = Object.entries(entries)
  return commitSettings(async (client) => {
    if (rows.some(([key]) => key === 'byoa_triage_backoff_base_ms' || key === 'byoa_triage_backoff_max_ms')) {
      const current = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
      const after = { ...makeSnapshot(current.rows).settings }
      for (const [key, value] of rows) after[key] = value ?? settingEnvValue(SETTING_DEFS.find(d => d.key === key)!)
      if (Number(after.byoa_triage_backoff_base_ms) > Number(after.byoa_triage_backoff_max_ms)) {
        throw new InvalidServerSettingError('BYOA triage backoff must satisfy base <= max')
      }
    }
    if (rows.some(([key]) => key === 'triage_backoff_base_ms' || key === 'triage_backoff_max_ms')) {
      const current = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
      const after = { ...makeSnapshot(current.rows).settings }
      for (const [key, value] of rows) after[key] = value ?? settingEnvValue(SETTING_DEFS.find(d => d.key === key)!)
      if (Number(after.triage_backoff_base_ms) > Number(after.triage_backoff_max_ms)) {
        throw new InvalidServerSettingError('triage backoff must satisfy base <= max')
      }
    }
    if (rows.some(([key]) => key === 'compaction_soft_ratio' || key === 'compaction_hard_ratio')) {
      const current = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
      const after = { ...makeSnapshot(current.rows).settings }
      for (const [key, value] of rows) after[key] = value ?? SETTING_DEFS.find(d => d.key === key)!.envValue()
      if (!(Number(after.compaction_soft_ratio) < Number(after.compaction_hard_ratio))) {
        throw new InvalidServerSettingError('compaction ratios must satisfy 0 < soft < hard < 1')
      }
    }
    if (rows.some(([key]) => ['embed_model', 'llm_config', 'sub2api_group_config'].includes(key))) {
      const current = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
      const before = makeSnapshot(current.rows).settings
      const after = { ...before }
      for (const [key, value] of rows) after[key] = value ?? SETTING_DEFS.find(d => d.key === key)!.envValue()
      if (embeddingSpace(before) !== embeddingSpace(after)) {
        const column = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'agent_workspace' AND column_name = 'embedding') AS exists`,
        )
        if (column.rows[0]?.exists) {
          const vectors = await client.query<{ exists: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM agent_workspace WHERE embedding IS NOT NULL) AS exists',
          )
          if (vectors.rows[0]?.exists) throw new InvalidServerSettingError(
            'embedding_space_locked: existing vectors require the same embedding model and route (1536 dimensions); a dedicated migration is required',
          )
        }
      }
    }
    for (const [key, value] of rows) {
      await client.query('DELETE FROM server_settings WHERE key = $1', [value === null ? key : INHERIT_PREFIX + key])
      await client.query(
        `INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [value === null ? INHERIT_PREFIX + key : key, value ?? 'true'],
      )
    }
  })
}

export async function writeInEmbeddingSpace(expected: ServerSettingsSnapshot, write: (client: PoolClient) => Promise<void>): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE server_settings IN SHARE MODE')
    const { rows } = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
    if (embeddingSpace(expected.settings) !== embeddingSpace(makeSnapshot(rows).settings)) {
      await client.query('ROLLBACK')
      console.warn('[embed] embedding_space_changed: discarding stale vector')
      return false
    }
    await write(client)
    await client.query('COMMIT')
    return true
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

function embeddingSpace(settings: Readonly<Record<string, string>>): string {
  const config = parseLlmConfig(settings.llm_config ?? '')
  const model = config.roles.find(r => r.role === 'embed' && r.purpose === undefined)?.models[0]
    ?? settings.embed_model.trim()
  const metadata = config.models.find(m => m.model === model)
  const route = config.routes.find(r => r.id === metadata?.route)
  return JSON.stringify({
    model, legacyModel: settings.embed_model.trim(), dimensions: 1536,
    route: route ? [route.kind, route.platform ?? null, route.env ?? null, route.protocol ?? null] : null,
    protocol: metadata?.protocol ?? null,
    groups: route?.kind === 'direct' ? null : ['free', 'pro', 'max'].map(tier =>
      parseGroupConfig(settings.sub2api_group_config ?? '')[tier as 'free' | 'pro' | 'max']?.[route?.platform ?? 'openai'] ?? null),
  })
}

export const LLM_ROLES = ['brain', 'support', 'compaction', 'image', 'audio', 'embed'] as const
export type LlmRole = typeof LLM_ROLES[number]
export type LlmProtocol = 'responses' | 'chat' | 'images' | 'dashscope-image' | 'embeddings'
export interface LlmRouteConfig {
  id: string
  kind: 'gateway' | 'direct'
  platform?: 'openai' | 'kimi' | 'deepseek' | 'grok'
  env?: 'text' | 'image' | 'audio' | 'embed' | 'novita' | 'orcarouter'
  protocol?: LlmProtocol
}
export interface LlmModelMetadata {
  model: string
  route?: string
  roles?: LlmRole[]
  protocol?: LlmProtocol
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  contextWindow?: number
  maxOutputTokens?: number
  thinking?: boolean
  tools?: boolean
  vision?: boolean
}
export interface LlmDirectTarget { model: string; route: string; protocol?: LlmProtocol }
export interface LlmRoleConfig {
  role: LlmRole
  purpose?: string
  models: string[]
  fallbackPolicy?: 'disabled' | 'env_after_chain'
  directTargets?: LlmDirectTarget[]
}
export interface LlmConfig { version: 1; routes: LlmRouteConfig[]; models: LlmModelMetadata[]; roles: LlmRoleConfig[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim()
const protocols = ['responses', 'chat', 'images', 'dashscope-image', 'embeddings']

export function parseLlmConfig(raw: string, strict = false): LlmConfig {
  const empty: LlmConfig = { version: 1, routes: [], models: [], roles: [] }
  if (!raw.trim()) return empty
  try {
    const c: unknown = JSON.parse(raw)
    const check = (ok: unknown) => { if (!ok) throw new Error('schema') }
    check(object(c))
    const b = c as Record<string, unknown>
    check(Object.keys(b).every(k => ['version', 'routes', 'models', 'roles'].includes(k)) && b.version === 1)
    for (const key of ['routes', 'models', 'roles']) check(b[key] === undefined || Array.isArray(b[key]))
    const config = { ...empty, ...b } as LlmConfig
    const ids = new Set<string>()
    for (const r of config.routes) {
      check(object(r) && Object.keys(r).every(k => ['id', 'kind', 'platform', 'env', 'protocol'].includes(k)))
      check(nonempty(r.id) && !ids.has(r.id)); ids.add(r.id)
      check(['gateway', 'direct'].includes(r.kind))
      check(r.protocol === undefined || protocols.includes(r.protocol))
      check(r.kind === 'gateway' ? r.env === undefined && (r.platform === undefined || ['openai', 'kimi', 'deepseek', 'grok'].includes(r.platform))
        : r.platform === undefined && ['text', 'image', 'audio', 'embed', 'novita', 'orcarouter'].includes(r.env!))
    }
    const models = new Set<string>()
    for (const m of config.models) {
      check(object(m) && Object.keys(m).every(k => ['model', 'route', 'roles', 'protocol', 'effort', 'contextWindow', 'maxOutputTokens', 'thinking', 'tools', 'vision'].includes(k)))
      check(nonempty(m.model) && !models.has(m.model)); models.add(m.model)
      check(m.route === undefined || ids.has(m.route))
      check(m.protocol === undefined || protocols.includes(m.protocol))
      check(m.roles === undefined || (Array.isArray(m.roles) && m.roles.length > 0 && m.roles.every(r => LLM_ROLES.includes(r))))
      check(m.effort === undefined || ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(m.effort))
      for (const key of ['thinking', 'tools', 'vision'] as const) check(m[key] === undefined || typeof m[key] === 'boolean')
      for (const [key, max] of [['contextWindow', 2_000_000], ['maxOutputTokens', 1_000_000]] as const) check(m[key] === undefined || (Number.isSafeInteger(m[key]) && m[key]! > 0 && m[key]! <= max))
    }
    const roles = new Set<string>()
    for (const r of config.roles) {
      check(object(r) && Object.keys(r).every(k => ['role', 'purpose', 'models', 'fallbackPolicy', 'directTargets'].includes(k)))
      check(LLM_ROLES.includes(r.role) && (r.purpose === undefined || nonempty(r.purpose)))
      const id = JSON.stringify([r.role, r.purpose]); check(!roles.has(id)); roles.add(id)
      check(Array.isArray(r.models) && r.models.length > 0 && r.models.every(nonempty))
      check(r.fallbackPolicy === undefined || ['disabled', 'env_after_chain'].includes(r.fallbackPolicy))
      check(r.directTargets === undefined || Array.isArray(r.directTargets))
      for (const target of r.directTargets ?? []) {
        check(object(target) && Object.keys(target).every(k => ['model', 'route', 'protocol'].includes(k)))
        check(nonempty(target.model) && config.routes.some(route => route.id === target.route && route.kind === 'direct'))
        check(target.protocol === undefined || protocols.includes(target.protocol))
        const protocol = target.protocol ?? config.routes.find(route => route.id === target.route)?.protocol
        check(protocol === undefined || (['brain', 'support', 'compaction'].includes(r.role) ? ['responses', 'chat'].includes(protocol)
          : r.role === 'image' ? ['images', 'dashscope-image'].includes(protocol) : r.role === 'audio' && protocol === 'chat'))
      }
      check(r.role !== 'embed' || (r.models.length === 1 && r.purpose === undefined && r.fallbackPolicy === undefined && r.directTargets === undefined))
    }
    return config
  } catch {
    if (strict) throw new InvalidServerSettingError('invalid llm_config schema')
    console.warn('[settings] invalid llm_config; using legacy role settings')
    return empty
  }
}

/** Translate only recognized legacy model settings; explicit routes keep model IDs verbatim. */
export function readLlmModelTarget(model: string, config: LlmConfig, target?: LlmDirectTarget) {
  const metadata = config.models.find(m => m.model === model)
  const explicit = config.routes.find(r => r.id === (target?.route ?? metadata?.route))
  if (explicit) return { requestModel: model, route: explicit, protocol: target ? target.protocol ?? explicit.protocol ?? metadata?.protocol : metadata?.protocol ?? explicit.protocol, metadata }
  const provider = model.startsWith('novita/') ? 'novita' : model.startsWith('orcarouter/') ? 'orcarouter' : undefined
  if (provider) return { requestModel: model.slice(provider.length + 1),
    route: { id: 'direct:' + provider, kind: 'direct', env: provider, protocol: provider === 'novita' ? 'chat' : 'responses' } as LlmRouteConfig,
    protocol: metadata?.protocol, metadata }
  return { requestModel: model, route: undefined, protocol: metadata?.protocol, metadata }
}

export type Sub2apiGroupConfig = Partial<Record<'free' | 'pro' | 'max', Partial<Record<'openai' | 'kimi' | 'deepseek' | 'grok', number>>>>
export function parseGroupConfig(raw: string, strict = false): Sub2apiGroupConfig {
  if (!raw.trim()) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!object(value)) throw new Error('schema')
    for (const [tier, groups] of Object.entries(value)) {
      if (!['free', 'pro', 'max'].includes(tier) || !object(groups)) throw new Error('schema')
      for (const [platform, id] of Object.entries(groups)) {
        if (!['openai', 'kimi', 'deepseek', 'grok'].includes(platform) || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('schema')
      }
    }
    return value as Sub2apiGroupConfig
  } catch {
    if (strict) throw new InvalidServerSettingError('invalid sub2api_group_config schema')
    console.warn('[settings] invalid sub2api_group_config; using env mapping')
    return {}
  }
}

export function getByoaRuntimePolicyValues(): { revision: string; values: ByoaPolicyValues } {
  const { revision, settings } = getServerSettingsSnapshot()
  return { revision, values: {
    bigBrainConcurrency: Number(settings.byoa_big_brain_concurrency),
    triageConcurrency: Number(settings.byoa_triage_concurrency),
    spawnIntervalMs: Number(settings.byoa_spawn_interval_ms),
    triageTimeoutMs: Number(settings.byoa_triage_timeout_ms),
    triageBackoffBaseMs: Number(settings.byoa_triage_backoff_base_ms),
    triageBackoffMaxMs: Number(settings.byoa_triage_backoff_max_ms),
    groupSteerEnabled: settings.byoa_group_steer_enabled === 'true',
    groupSteerIntervalMs: Number(settings.byoa_group_steer_interval_ms),
  } }
}
