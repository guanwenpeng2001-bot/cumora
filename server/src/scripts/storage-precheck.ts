import { checkStorageConfig } from '../storage-config.js'

try {
  console.log('storage preflight: ' + checkStorageConfig(process.env))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Storage preflight failed')
  process.exitCode = 1
}
