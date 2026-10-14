import { aes256Key, sessionPassword } from '@towerism/selfhost-kit';

/**
 * Genie's secrets: env first, else a file generated once in `<data>/secrets/` (the kit's contract). The file
 * names are part of the install contract: never rename them. No side effects on import, so the logger's
 * redaction list can read it too.
 */
export const SECRETS = [
  sessionPassword(),
  aes256Key({ env: 'NUXT_VAULT_KEY', file: 'vault.key', label: 'Vault key' }),
] as const;
