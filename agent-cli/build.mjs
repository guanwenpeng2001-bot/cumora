// Bundle the BYOA daemon into a single standalone, dependency-free Node
// executable for the public `cumora` npm package. The daemon only uses Node
// builtins + global fetch, so the output needs nothing installed beyond Node.
import { build } from 'esbuild'
import { existsSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isBuiltin } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Fixed Release builds identify both the fork version and source commit.
const pkgVersion = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+-fork\.\d+$/.test(pkgVersion)) throw new Error('expected a fork version: X.Y.Z-fork.N')
const commit = (process.env.CUMORA_BUILD_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' })).trim()
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('CUMORA_BUILD_COMMIT must be a full Git commit hash')
const version = `${pkgVersion}+${commit}`

// The repo's TS sources use NodeNext `.js` import specifiers that actually
// resolve to sibling `.ts` files. esbuild won't rewrite those, so remap a
// relative `.js` import to its `.ts` source when the `.ts` exists.
const tsExtFix = {
  name: 'ts-ext-fix',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (!args.path.endsWith('.js')) return undefined
      const ts = resolve(args.resolveDir, args.path).replace(/\.js$/, '.ts')
      return existsSync(ts) ? { path: ts } : undefined
    })
  },
}

const outdir = resolve(process.env.CUMORA_CLI_OUTDIR || resolve(here, 'dist'))
const outfile = resolve(outdir, 'cli.js')
const result = await build({
  entryPoints: [resolve(here, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile,
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  metafile: true,
  write: false,
  define: { __CUMORA_VERSION__: JSON.stringify(version), __CUMORA_RELEASE__: 'true', __CUMORA_DEFAULT_SERVER__: JSON.stringify(process.env.CUMORA_DEFAULT_SERVER?.trim() || '') },
  plugins: [tsExtFix],
})
const forbidden = Object.keys(result.metafile.inputs).filter((input) =>
  /(?:^|\/)(?:pg|pg-pool|drizzle-orm|ioredis)(?:\/|$)/.test(input.replaceAll('\\', '/')) ||
  /server\/src\/(?:db(?:\/|\.ts$)|(?:settings|env|model-pricing)\.ts$)/.test(input.replaceAll('\\', '/')),
)
const external = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
  .filter((entry) => entry.external && !isBuiltin(entry.path))
if (forbidden.length || external.length) throw new Error(`CLI must remain standalone: ${JSON.stringify({ forbidden, external })}`)
const { mkdirSync } = await import('node:fs')
mkdirSync(outdir, { recursive: true })
for (const output of result.outputFiles) writeFileSync(output.path, output.contents)
writeFileSync(resolve(outdir, 'build-info.json'), JSON.stringify({ version, packageVersion: pkgVersion, commit, release: true }, null, 2) + '\n')
chmodSync(outfile, 0o755)
console.log(`[agent-cli] built ${outfile} (${version})`)
