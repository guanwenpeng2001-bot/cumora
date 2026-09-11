import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function renderK8s(template, values) {
  const rendered = template.replace(/\$\{([A-Z_]+)\}/g, (_, key) => {
    const value = values[key]
    if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) throw new Error('Missing or unsafe template variable: ' + key)
    return value
  })
  if (/REPLACE-|\$\{/.test(rendered)) throw new Error('Unresolved template placeholder')
  return rendered
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2]
    if (!['gke', 'orbstack'].includes(mode)) throw new Error('Usage: node scripts/render-k8s.mjs gke|orbstack')
    const template = readFileSync(new URL('../server/k8s/cumora-server.' + mode + '.yaml', import.meta.url), 'utf8')
    process.stdout.write(renderK8s(template, process.env))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
