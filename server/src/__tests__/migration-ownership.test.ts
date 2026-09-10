import { test } from 'node:test'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const readRepo = (path: string): Promise<string> => readFile(resolve(repoRoot, path), 'utf8')

test('application startup verifies schema compatibility and imports no migrator', async () => {
  const source = await readRepo('server/src/index.ts')
  assert.match(source, /verifySchemaWithBootRetry/)
  assert.doesNotMatch(source, /from ['"]\.\/db\/migrate\.js['"]/)
  assert.doesNotMatch(source, /ensureSchema/)
})

test('application Pod manifests contain no per-replica migration container', async () => {
  for (const path of [
    'server/k8s/cumora-server.gke.yaml',
    'server/k8s/cumora-server.orbstack.yaml',
  ]) {
    const manifest = await readRepo(path)
    assert.doesNotMatch(manifest, /^\s*- name: migrate\s*$/m, `${path} must not run DDL per replica`)
    assert.doesNotMatch(manifest, /command:\s*\["npm",\s*"run",\s*"migrate"\]/)
  }
})

test('production deploy migrates before one atomic Deployment mutation', async () => {
  const workflow = await readRepo('.github/workflows/deploy.yml')
  const migrationAt = workflow.indexOf('- name: Run candidate migrations once')
  const patchAt = workflow.indexOf('- name: Patch deployment')
  assert.ok(migrationAt >= 0, 'deploy must create a single candidate migration Job')
  assert.ok(patchAt > migrationAt, 'migration must complete before Deployment mutation')
  assert.match(workflow, /kind:\s*"Job"/)
  assert.match(workflow, /Candidate database migration did not complete; deployment was not mutated/)
  assert.match(workflow, /\{ name: "migrate", "\$patch": "delete" \}/)
})

test('K8s templates render server namespace consistently for RBAC and agent URLs', async () => {
  const { loadAll } = createRequire(import.meta.url)('js-yaml') as { loadAll: (yaml: string) => Array<Record<string, any>> }
  for (const variant of ['gke', 'orbstack']) {
    const template = await readRepo('server/k8s/cumora-server.' + variant + '.yaml')
    for (const namespace of ['default', 'cumora-staging']) {
      const rendered = template.replaceAll('$' + '{CUMORA_NAMESPACE}', namespace)
      const docs = loadAll(rendered).filter(Boolean)
      assert.equal(docs.length, variant === 'gke' ? 8 : 7)
      for (const doc of docs) {
        if (!doc.kind.startsWith('Cluster')) assert.equal(doc.metadata.namespace, namespace)
      }
      const binding = docs.find(doc => doc.kind === 'ClusterRoleBinding')!
      const sa = docs.find(doc => doc.kind === 'ServiceAccount')!
      assert.equal(binding.subjects[0].namespace, sa.metadata.namespace)
      assert.equal(binding.subjects[0].name, sa.metadata.name)
      const deployment = docs.find(doc => doc.kind === 'Deployment')!
      const server = deployment.spec.template.spec.containers.find((c: { name: string }) => c.name === 'server')
      assert.ok(server.env.some((e: { name: string; value: string }) => e.name === 'CUMORA_AGENT_NAMESPACE' && e.value === namespace))
      assert.ok(server.env.some((e: { name: string; value: string }) => e.name === 'AGENT_RUNTIME_SERVER_URL' && e.value === 'http://cumora-server.' + namespace + '.svc.cluster.local:5181/runtime'))
    }
  }
})
