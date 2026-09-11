import { identity, revision, type CredentialInventory } from './inventory.js'
import { parseApiKeyMap } from '../sub2api.js'

/** Server-only pointers; this module intentionally cannot resolve or mint secrets. */
export function credentialReferences(credentials: CredentialInventory[]) {
  return credentials.filter(c => c.present).map(c => ({ id: identity('credential', c.ownerUserId, 'sub2api', c.platform),
    owner_user_id: c.ownerUserId, source_id: 'sub2api', platform: c.platform, remote_user_id: c.remoteUserId, key_id: c.keyId,
    secret_ref: `users/${encodeURIComponent(c.ownerUserId)}/sub2api_api_key/${encodeURIComponent(c.platform)}`,
    status: 'legacy-reference', revision: revision(c), integration_owner: c.integrationOwner }))
}

/** Compare only in server memory. Neither key values nor hashes are returned or persisted. */
export function matchLegacyCredentialIds(credentials: CredentialInventory[], users: Array<{ id: string; sub2api_api_key: string | null }>, keys: Array<{ id: number; user_id: number; key: string }>): CredentialInventory[] {
  return credentials.map(c => {
    if (c.keyId !== null) return c
    const raw = parseApiKeyMap(users.find(u => u.id === c.ownerUserId)?.sub2api_api_key)[c.platform]
    const matches = raw ? keys.filter(k => k.user_id === Number(c.remoteUserId) && k.key === raw) : []
    return matches.length === 1 ? { ...c, keyId: matches[0].id } : c
  })
}
