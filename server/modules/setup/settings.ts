import type { Clock, Logger } from '@towerism/selfhost-kit';
import type { CreateDiscord, GuildInfo } from '../discord/port';
import type { SetupService } from './service';
import type { SetupStore } from './store';

export interface Settings {
  guild: { id: string; name: string };
  organizerRole: { id: string; name: string | null } | null;
  headJudgeRole: { id: string; name: string | null } | null;
  ownerId: string;
  organizerAllowlistEnabled: boolean;
}

export interface Allowlist {
  enabled: boolean;
  userIds: string[];
}

/** Settings as M1 has them: read-only guild and roles, and the owner's organizer allowlist (§9). */
export function createSettingsService(opts: {
  store: SetupStore;
  setup: SetupService;
  createDiscord: CreateDiscord;
  clock: Clock;
  logger: Logger;
}) {
  const { store, setup, createDiscord, clock, logger } = opts;

  return {
    async settings(): Promise<Settings> {
      const binding = store.binding();
      const ownerId = store.install()?.ownerDiscordUserId;
      if (!binding || !ownerId) throw new Error('Setup is not complete.');
      let guild: GuildInfo | null = null;
      try {
        guild = await createDiscord(setup.botToken()).gateway.getGuild(binding.guildId);
      } catch (err) {
        logger.warn('Could not read the role names.', { err });
      }
      const role = (id: string | null) => (id === null ? null : { id, name: guild?.roles.find((r) => r.id === id)?.name ?? null });
      return {
        guild: { id: binding.guildId, name: binding.name },
        organizerRole: role(binding.organizerRoleId),
        headJudgeRole: role(binding.headJudgeRoleId),
        ownerId,
        organizerAllowlistEnabled: binding.organizerAllowlistEnabled,
      };
    },

    allowlist(): Allowlist {
      return { enabled: store.binding()?.organizerAllowlistEnabled ?? false, userIds: store.allowlist() };
    },

    /** Replaces the list. Enabled and empty leaves only the owner as organizer, so the answer warns. */
    putAllowlist(input: Allowlist): Allowlist & { warnings: 'empty_allowlist'[] } {
      store.replaceAllowlist(input.userIds, input.enabled, clock.now());
      logger.info('Organizer allowlist changed.', { enabled: input.enabled, count: input.userIds.length });
      const saved = { enabled: input.enabled, userIds: store.allowlist() };
      return { ...saved, warnings: input.enabled && saved.userIds.length === 0 ? ['empty_allowlist'] : [] };
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
