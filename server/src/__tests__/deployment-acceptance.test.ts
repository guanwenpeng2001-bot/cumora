import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { checkStorageConfig, REQUIRED_R2_KEYS } from '../storage-config.js'

const require = createRequire(import.meta.url)
const { loadAll, load } = require('js-yaml')
const read = (path: string) => readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')

test('K8s storage rejects each absent or whitespace R2 key, permits local Compose and complete R2', () => {
  const complete = { CUMORA_REQUIRE_R2: 'true', R2_ENDPOINT: 'https://r2.example.test', R2_BUCKET: 'bucket', R2_ACCESS_KEY_ID: 'fixture', R2_SECRET_ACCESS_KEY: 'fixture' }
  assert.equal(checkStorageConfig({}), 'local')
  assert.equal(checkStorageConfig(complete), 'r2')
  for (const key of REQUIRED_R2_KEYS) {
    for (const value of [undefined, '', '  ']) assert.throws(() => checkStorageConfig({ ...complete, [key]: value }), new RegExp(key))
  }
  assert.throws(() => checkStorageConfig({ ...complete, R2_ENDPOINT: 'file:///tmp/bucket' }), /HTTP/)
})

test('rendered K8s templates distinguish single-replica uploads PVC from GKE shared storage', async () => {
  const { renderK8s } = await import(new URL('../../../scripts/render-k8s.mjs', import.meta.url).href)
  const values = { CUMORA_NAMESPACE: 'acceptance-ns', AR_REGION: 'us-west2', GCP_PROJECT: 'acceptance-project', AR_REPO: 'cumora', IMAGE_TAG: '0594315', SQL_CONNECTION_NAME: 'acceptance-project:us-west2:pg' }
  for (const mode of ['gke', 'orbstack']) {
    const template = read(`server/k8s/cumora-server.${mode}.yaml`)
    const rendered = renderK8s(template, values)
    const docs = loadAll(rendered)
    const pod = docs.find((d: any) => d.kind === 'Deployment').spec.template.spec
    const server = pod.containers.find((c: any) => c.name === 'server')
    if (mode === 'gke') {
      assert.equal(server.env.find((e: any) => e.name === 'CUMORA_REQUIRE_R2').value, 'true')
      for (const key of REQUIRED_R2_KEYS) assert.deepEqual(server.env.find((e: any) => e.name === key).valueFrom.secretKeyRef, { name: 'cumora', key, optional: false })
      assert.equal(server.image, 'us-west2-docker.pkg.dev/acceptance-project/cumora/server:0594315')
      assert.equal(server.env.find((e: any) => e.name === 'CUMORA_AGENT_COMPUTER_IMAGE').value, 'us-west2-docker.pkg.dev/acceptance-project/cumora/agent-computer:0594315')
      assert.equal(pod.imagePullSecrets, undefined)
      assert.equal(server.env.find((e: any) => e.name === 'CUMORA_AGENT_PULL_SECRETS').value, '')
      assert.ok(pod.containers.find((c: any) => c.name === 'cloud-sql-proxy').args.includes('--http-address=0.0.0.0'))
    }
    if (mode === 'orbstack') {
      const deployment = docs.find((d: any) => d.kind === 'Deployment')
      assert.equal(deployment.spec.replicas, 1)
      assert.deepEqual(deployment.spec.strategy, { type: 'Recreate' })
      const config = Object.fromEntries(server.env.filter((e: any) => e.value !== undefined).map((e: any) => [e.name, e.value]))
      assert.equal(config.CUMORA_REQUIRE_R2, 'false')
      assert.equal(checkStorageConfig(config), 'local', 'the actual variant env passes storage-precheck without R2')
      assert.ok(!server.env.some((e: any) => REQUIRED_R2_KEYS.includes(e.name)))
      const mount = server.volumeMounts.find((m: any) => m.mountPath === '/app/server/uploads')
      const volume = pod.volumes.find((v: any) => v.name === mount.name)
      const pvc = docs.find((d: any) => d.kind === 'PersistentVolumeClaim' && d.metadata.name === volume.persistentVolumeClaim.claimName)
      assert.deepEqual(pvc.spec.accessModes, ['ReadWriteOnce'])
      assert.equal(pvc.spec.resources.requests.storage, '10Gi')
      assert.equal(pvc.metadata.namespace, values.CUMORA_NAMESPACE)
    }
    assert.throws(() => renderK8s(template, {}), /Missing/)
    assert.throws(() => renderK8s(template, { ...values, CUMORA_NAMESPACE: 'bad\nvalue' }), /unsafe/)
  }
})

test('rollback gate rejects changed checksums and schema tips; workflow guards exact revision undo', async () => {
  const { checkRollbackManifests } = await import(new URL('../../../scripts/rollback-precheck.mjs', import.meta.url).href)
  const manifest = read('server/src/db/migrations/manifest.ts')
  assert.equal(checkRollbackManifests(manifest, manifest).compatible, true)
  const altered = manifest.replace(/checksum: '[a-f0-9]{64}'/, "checksum: '" + '0'.repeat(64) + "'")
  assert.equal(checkRollbackManifests(manifest, altered).compatible, false)
  assert.throws(() => checkRollbackManifests(manifest, ''), /Cannot read/)
  const workflow = load(read('.github/workflows/deploy.yml'))
  const steps = workflow.jobs.deploy.steps
  const migrate = steps.find((s: any) => s.id === 'migrate').run
  assert.match(migrate, /storage-precheck\.ts && npm run migrate/)
  assert.match(migrate, /name: "CUMORA_REQUIRE_R2", value: "true"/)
  assert.ok(steps.findIndex((s: any) => s.id === 'rollback_gate') < steps.findIndex((s: any) => s.id === 'migrate'))
  const undo = steps.find((s: any) => s.name === 'Automatic rollback when smoke evidence fails').run
  assert.ok(undo.indexOf('compatible') < undo.indexOf('kubectl rollout undo'))
  assert.match(undo, /rollback-precheck\.mjs/)
  assert.match(undo, /--to-revision=/)
})
