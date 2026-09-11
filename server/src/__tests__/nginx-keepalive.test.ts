import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

test('nginx pools upstream connections while keeping runtime DNS resolution', () => {
  const config = readFileSync(new URL('../../../deploy/nginx.conf', import.meta.url), 'utf8')
  assert.match(config, /upstream cumora_api\s*\{[^}]*zone cumora_api[^}]*resolver 127\.0\.0\.11 valid=5s[^}]*server server:5181 resolve;[^}]*keepalive 64;/)
  assert.match(config, /proxy_http_version 1\.1;/)
  assert.match(config, /proxy_set_header Connection "";/)
  assert.doesNotMatch(config, /proxy_pass \$upstream/)
  const dockerfile = readFileSync(new URL('../../../deploy/web.Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /FROM nginx:1\.27\.5-alpine/)
})

test('nginx -t validates the loaded keepalive and dynamic DNS configuration',
  { skip: !process.env.PERF_NGINX_CONTAINER }, () => {
    const result = execFileSync(process.env.PERF_DOCKER_BIN ?? 'docker',
      ['exec', process.env.PERF_NGINX_CONTAINER!, 'nginx', '-t'], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' })
    assert.ok(typeof result === 'string') // exit status is checked by execFileSync
  })
