export type GuardResult = { ok: true } | { ok: false; reason: 'guild_mismatch' | 'guild_not_marked' };

export const GUILD_MARKER = 'genie-spike';

/** Every mutating command runs this first: only the configured, visibly marked test guild is touched. */
export function guard(guild: { id: string; name: string }, configuredGuildId: string): GuardResult {
  if (guild.id !== configuredGuildId) return { ok: false, reason: 'guild_mismatch' };
  if (!guild.name.toLowerCase().startsWith(GUILD_MARKER)) return { ok: false, reason: 'guild_not_marked' };
  return { ok: true };
}
