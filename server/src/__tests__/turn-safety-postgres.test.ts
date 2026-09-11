import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { TURN_SAFETY_SQL, turnSafetyChecksum } from '../db/migrations/0018-turn-safety.js'
import { SCHEMA_MIGRATIONS } from '../db/migrations/manifest.js'
import { TURN_ADMISSION_SQL } from '../turn-safety-policy.js'

test('turn safety migration checksum matches immutable manifest', () => {
  assert.equal(SCHEMA_MIGRATIONS[17].checksum, turnSafetyChecksum())
})

// Explicit opt-in: never consult DATABASE_URL, never connect to an existing
// service. PostgreSQL single-user mode works without network/socket access.
test('real PostgreSQL: retained backfill, counters, retry/correction, UTC reset and tenant admission', {
  skip: !process.env.TURN_SAFETY_TEST_PGDATA,
}, () => {
  const data = process.env.TURN_SAFETY_TEST_PGDATA!
  assert.equal(resolve(data), resolve('.tmp-fix-y2-db'), 'only the disposable fix-y2 cluster is allowed')
  const sql = `BEGIN;
    CREATE SCHEMA safety_test;
    SET search_path = safety_test;
    SET timezone = 'Asia/Shanghai';
    CREATE TABLE companies(id text primary key);
    CREATE TABLE llm_calls(id text primary key, company_id text, agent_id text, created_at timestamptz default now(),
      input_tokens integer default 0, cached_input_tokens integer default 0, cache_creation_tokens integer default 0,
      output_tokens integer default 0, cost_usd float8 default 0);
    CREATE TABLE llm_calls_rollup(company_id text, agent_id text, bucket_hour timestamptz,
      input_tokens bigint, cached_input_tokens bigint, cache_creation_tokens bigint, output_tokens bigint, cost_usd float8);
    CREATE TABLE llm_calls_rollup_v2(LIKE llm_calls_rollup);
    CREATE TABLE llm_rollup_state(coverage_from timestamptz, completed_through timestamptz);
    INSERT INTO companies VALUES ('a'), ('b');
    INSERT INTO llm_rollup_state VALUES (date_trunc('month', now(), 'UTC'), date_trunc('hour', now(), 'UTC'));
    INSERT INTO llm_calls_rollup_v2 VALUES ('a', 'agent-a', date_trunc('month', now(), 'UTC'), 10,20,30,40,0.5);
    INSERT INTO llm_calls VALUES ('seed-overlap','a','agent-a',date_trunc('month',now(),'UTC'),10,20,30,40,0.5);
    ${TURN_SAFETY_SQL}
    DO $$ BEGIN
      ASSERT (SELECT tokens = 100 AND usd = 0.5 FROM turn_budget_usage WHERE company_id='a' AND agent_id='' AND period='month'), 'backfill overlap counted twice';
    END $$;
    INSERT INTO llm_calls(id,company_id,agent_id,input_tokens,cached_input_tokens,cache_creation_tokens,output_tokens,cost_usd)
      VALUES ('new','a','agent-a',10,20,30,40,0.25);
    INSERT INTO llm_calls(id,company_id,agent_id,input_tokens) VALUES ('new','a','agent-a',999) ON CONFLICT DO NOTHING;
    UPDATE llm_calls SET input_tokens=20, cost_usd=0.75 WHERE id='new';
    INSERT INTO llm_calls(id,company_id,agent_id,input_tokens) VALUES ('other','b','agent-a',9000);
    INSERT INTO turn_budget_rules VALUES ('agent-day','a','agent-a','day','tokens',110), ('company-month','a','','month','usd',1.25);
    DO $$ DECLARE result RECORD; BEGIN
      ASSERT (SELECT tokens = 210 AND usd = 1.25 FROM turn_budget_usage WHERE company_id='a' AND agent_id='' AND period='month'), 'usage corrections/retries';
      ASSERT (SELECT tokens = 210 FROM turn_budget_usage WHERE company_id='a' AND agent_id='agent-a' AND period='month'), 'agent counter';
      ASSERT (SELECT tokens = 9000 FROM turn_budget_usage WHERE company_id='b' AND agent_id='' AND period='month'), 'tenant isolation';
      ${admission('a', 'agent-a')}
      ASSERT cardinality(result.blocked)=2, 'both limits must apply at equality';
      ${admission('a', 'agent-b')}
      ASSERT cardinality(result.blocked)=1, 'company budget applies to all agents';
      ${admission('b', 'agent-a')}
      ASSERT cardinality(result.blocked)=0, 'foreign company budget leaked';
    END $$;
    UPDATE turn_budget_rules SET ceiling=2000 WHERE id='agent-day';
    DELETE FROM turn_budget_rules WHERE id='company-month';
    DO $$ DECLARE result RECORD; BEGIN
      ${admission('a', 'agent-a')}
      ASSERT cardinality(result.blocked)=0, 'manual raise/remove did not clear fuse';
    END $$;
    UPDATE turn_budget_rules SET ceiling=1;
    UPDATE turn_budget_usage SET period_start=period_start-INTERVAL '1 year' WHERE company_id='a';
    DO $$ DECLARE result RECORD; BEGIN
      ${admission('a', 'agent-a')}
      ASSERT cardinality(result.blocked)=0, 'previous period must not block';
      ASSERT result.generation='0' AND NOT result.paused, 'default admission';
    END $$;
    INSERT INTO company_turn_safety(company_id,paused,generation) VALUES ('a',TRUE,1);
    DO $$ DECLARE result RECORD; BEGIN
      ${admission('a', 'agent-a')}
      ASSERT result.paused AND result.generation='1', 'emergency pause not visible';
      ${admission('b', 'agent-a')}
      ASSERT NOT result.paused, 'emergency pause crossed tenants';
    END $$;
    UPDATE company_turn_safety SET paused=FALSE WHERE company_id='a';
    DO $$ DECLARE result RECORD; BEGIN
      ${admission('a', 'agent-a')}
      ASSERT NOT result.paused AND result.generation='1', 'resume must not resurrect old generation';
    END $$;
    ROLLBACK;
    SELECT 'SAFETY_SQL_OK';`
  const input = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join(' ') + '\n'
  const result = spawnSync(process.env.TURN_SAFETY_POSTGRES ?? 'C:/Program Files/PostgreSQL/18/bin/postgres.exe',
    ['--single', '-D', data, 'postgres'], { input, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`)
  assert.doesNotMatch(result.stderr, /ERROR:|FATAL:|PANIC:/, result.stderr)
  assert.match(result.stdout, /SAFETY_SQL_OK/)
})

function admission(company: string, agent: string): string {
  return `${TURN_ADMISSION_SQL.replace(' blocked\n', ' blocked INTO result\n')
    .replaceAll('$1', `'${company}'`).replaceAll('$2', `'${agent}'`)};`
}
