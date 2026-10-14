import type { Clock, Logger, StringVault } from '@towerism/selfhost-kit';
import { inviteUrl } from '../../../shared/discord/permissions';
import type { SealedSecretName } from '../../db/schema';
import {
  type ApplicationInfo,
  type CreateDiscord,
  type DiscordGateway,
  type GuildInfo,
  DiscordAuthError,
  DiscordUnavailableError,
} from '../discord/port';
import { type CheckInput, type Checks, allPassed, computeChecks } from './checks';
import { SetupError } from './errors';
import type { SetupStore } from './store';

export { SetupError };

export interface SetupProgress {
  complete: boolean;
  clientId: string | null;
  guild: { id: string; name: string } | null;
  organizerRoleId: string | null;
  headJudgeRoleId: string | null;
  ownerId: string | null;
  inviteUrl: string | null;
  lastChecks: Checks | null;
}

export type BindOwnerOutcome = 'bound' | 'choose_guild_first' | 'owner_not_in_guild' | 'setup_complete';

/** The AAD that binds each sealed secret to its row (selfhost-kit ADR-0006). */
export const aadFor = (name: SealedSecretName) => `sealed_secret:${name}`;

/**
 * The first-run wizard (architecture §6.1). Every step re-reads Discord live through the port; nothing here
 * trusts what the browser says about Discord. Once finished, every step answers `410 setup_complete`.
 */
export function createSetupService(opts: {
  store: SetupStore;
  vault: StringVault;
  createDiscord: CreateDiscord;
  clock: Clock;
  logger: Logger;
  /** Called after setup completes (starts the bot). */
  onComplete?: () => void;
}) {
  const { store, vault, createDiscord, clock, logger, onComplete } = opts;
  let lastChecks: Checks | null = null;

  // Setup steps run one at a time. A step reads Discord live before it writes, so two overlapping steps (a second
  // tab changing the guild while finish checks) could otherwise complete setup with a configuration nobody checked.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(step: () => Promise<T>): Promise<T> => {
    const run = queue.then(step, step);
    queue = run.catch(() => undefined);
    return run;
  };

  const isComplete = () => store.install()?.setupCompletedAt != null;
  const assertIncomplete = () => {
    if (isComplete()) throw new SetupError(410, 'setup_complete', 'Setup is already complete.');
  };

  function unseal(name: SealedSecretName): string | null {
    const blob = store.sealed(name);
    if (!blob) return null;
    try {
      return vault.decrypt(blob, aadFor(name));
    } catch {
      throw new SetupError(503, 'secrets_unreadable', 'The stored Discord credentials could not be unsealed; check NUXT_VAULT_KEY.');
    }
  }

  function gateway(): DiscordGateway {
    const token = unseal('discord_bot_token');
    if (!token) throw new SetupError(409, 'discord_not_configured', 'Enter the Discord application first.');
    return createDiscord(token).gateway;
  }

  async function liveGuild(guildId: string): Promise<GuildInfo | null> {
    try {
      return await gateway().getGuild(guildId);
    } catch (err) {
      throw asSetupError(err);
    }
  }

  async function gatherChecks(): Promise<Checks> {
    const install = store.install();
    const binding = store.binding();
    const token = unseal('discord_bot_token');
    const input: CheckInput = {
      application: null,
      clientId: install?.discordClientId ?? null,
      guilds: null,
      guildId: binding?.guildId ?? null,
      guild: null,
      ownerId: install?.ownerDiscordUserId ?? null,
      ownerMember: null,
      organizerRoleId: binding?.organizerRoleId ?? null,
      headJudgeRoleId: binding?.headJudgeRoleId ?? null,
    };
    if (token) {
      const gw = createDiscord(token).gateway;
      input.application = await settle(gw.getApplication(), (err) => (err instanceof DiscordAuthError ? 'invalid_token' : 'unavailable'));
      if (typeof input.application === 'object') {
        input.guilds = await settle(gw.listGuilds(), () => 'unavailable' as const);
        if (input.guildId) {
          input.guild = await settle(gw.getGuild(input.guildId), () => 'unavailable' as const);
          if (input.ownerId && typeof input.guild === 'object' && input.guild !== null) {
            input.ownerMember = await settle(gw.getMember(input.guildId, input.ownerId), () => 'unavailable' as const);
          }
        }
      } else if (input.application === 'unavailable') {
        input.guilds = 'unavailable';
        if (input.guildId) input.guild = 'unavailable';
      }
    }
    lastChecks = computeChecks(input);
    return lastChecks;
  }

  return {
    isComplete,
    assertIncomplete,

    progress(): SetupProgress {
      const install = store.install();
      const binding = store.binding();
      const clientId = install?.discordClientId ?? null;
      return {
        complete: isComplete(),
        clientId,
        guild: binding ? { id: binding.guildId, name: binding.name } : null,
        organizerRoleId: binding?.organizerRoleId ?? null,
        headJudgeRoleId: binding?.headJudgeRoleId ?? null,
        ownerId: install?.ownerDiscordUserId ?? null,
        inviteUrl: clientId ? inviteUrl(clientId) : null,
        lastChecks,
      };
    },

    saveDiscord(input: { botToken: string; clientId: string; clientSecret: string }): Promise<Checks & { inviteUrl: string }> {
      return serialized(async () => {
        assertIncomplete();
        let app: ApplicationInfo;
        try {
          app = await createDiscord(input.botToken).gateway.getApplication();
        } catch (err) {
          if (err instanceof DiscordAuthError) throw new SetupError(422, 'invalid_bot_token', 'Discord refused that bot token.');
          throw asSetupError(err);
        }
        if (app.id !== input.clientId) {
          throw new SetupError(422, 'client_id_mismatch', 'That bot token belongs to a different application than the client ID.');
        }
        const now = clock.now();
        store.transaction(() => {
          store.ensureInstall(now);
          store.putSealed('discord_bot_token', vault.encrypt(input.botToken, aadFor('discord_bot_token')), now);
          store.putSealed('discord_client_secret', vault.encrypt(input.clientSecret, aadFor('discord_client_secret')), now);
          store.updateInstall({ discordClientId: input.clientId });
        });
        logger.info('Discord application stored.', { clientId: input.clientId });
        return { ...(await gatherChecks()), inviteUrl: inviteUrl(input.clientId) };
      });
    },

    async guilds(): Promise<{ id: string; name: string }[]> {
      assertIncomplete();
      try {
        return await gateway().listGuilds();
      } catch (err) {
        throw asSetupError(err);
      }
    },

    chooseGuild(guildId: string): Promise<Checks> {
      return serialized(async () => {
        assertIncomplete();
        const guild = await liveGuild(guildId);
        if (!guild) throw new SetupError(422, 'bot_not_in_guild', 'The bot is not in that server yet. Invite it first.');
        const ownerId = store.install()?.ownerDiscordUserId ?? null;
        const ownerStays = ownerId !== null && (await gateway().getMember(guildId, ownerId).catch(() => null)) !== null;
        const now = clock.now();
        store.transaction(() => {
          store.ensureInstall(now);
          const current = store.binding();
          if (current?.guildId !== guildId) store.bindGuild(guildId, guild.name, now);
          else store.updateBinding({ name: guild.name });
          if (!ownerStays) store.updateInstall({ ownerDiscordUserId: null });
        });
        return gatherChecks();
      });
    },

    async roles(): Promise<{ id: string; name: string; position: number }[]> {
      assertIncomplete();
      const binding = store.binding();
      if (!binding) throw new SetupError(409, 'guild_not_chosen', 'Choose the server first.');
      const guild = await liveGuild(binding.guildId);
      if (!guild) throw new SetupError(422, 'bot_not_in_guild', 'The bot is no longer in that server.');
      return guild.roles
        .filter((r) => r.id !== guild.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map(({ id, name, position }) => ({ id, name, position }));
    },

    mapRoles(sessionUserId: string | null, input: { organizerRoleId: string; headJudgeRoleId: string }): Promise<Checks> {
      return serialized(async () => {
        assertIncomplete();
        const ownerId = store.install()?.ownerDiscordUserId ?? null;
        if (ownerId === null || sessionUserId !== ownerId) {
          throw new SetupError(403, 'owner_required', 'Log in with Discord as the owner first.');
        }
        const binding = store.binding();
        if (!binding) throw new SetupError(409, 'guild_not_chosen', 'Choose the server first.');
        const guild = await liveGuild(binding.guildId);
        const known = new Set(guild?.roles.filter((r) => r.id !== guild.id).map((r) => r.id));
        const unknown = [input.organizerRoleId, input.headJudgeRoleId].filter((id) => !known.has(id));
        if (unknown.length) throw new SetupError(422, 'unknown_role', 'Pick roles from the server.', { roleIds: unknown });
        store.updateBinding({ organizerRoleId: input.organizerRoleId, headJudgeRoleId: input.headJudgeRoleId });
        return gatherChecks();
      });
    },

    /** Binds the install owner after a Discord login inside the unlocked wizard session (ADR-0004). */
    bindOwner(userId: string): Promise<BindOwnerOutcome> {
      return serialized(async () => {
        if (isComplete()) return 'setup_complete';
        const binding = store.binding();
        if (!binding) return 'choose_guild_first';
        const member = await gateway().getMember(binding.guildId, userId).catch((err: unknown) => {
          throw asSetupError(err);
        });
        if (!member) return 'owner_not_in_guild';
        store.updateInstall({ ownerDiscordUserId: userId });
        logger.info('Install owner bound in the setup wizard.', { userId });
        return 'bound';
      });
    },

    async check(): Promise<Checks> {
      assertIncomplete();
      return gatherChecks();
    },

    finish(): Promise<void> {
      return serialized(async () => {
        assertIncomplete();
        const checks = await gatherChecks();
        if (!allPassed(checks)) {
          throw new SetupError(422, 'setup_checks_failed', 'Some checks are failing.', { checks: checks.checks, warnings: checks.warnings });
        }
        store.transaction(() => {
          assertIncomplete();
          store.updateInstall({ setupCompletedAt: clock.now() });
        });
        logger.info('Setup is complete.');
        onComplete?.();
      });
    },

    oauthClient(): { clientId: string; clientSecret: string } | null {
      const clientId = store.install()?.discordClientId ?? null;
      const clientSecret = unseal('discord_client_secret');
      return clientId && clientSecret ? { clientId, clientSecret } : null;
    },

    botToken(): string {
      const token = unseal('discord_bot_token');
      if (!token) throw new SetupError(409, 'discord_not_configured', 'No bot token is stored.');
      return token;
    },
  };
}

export type SetupService = ReturnType<typeof createSetupService>;

function asSetupError(err: unknown): SetupError {
  if (err instanceof SetupError) return err;
  if (err instanceof DiscordUnavailableError || err instanceof DiscordAuthError) {
    return new SetupError(502, 'discord_unavailable', 'Discord could not be reached. Try again in a moment.');
  }
  throw err;
}

async function settle<T, F>(promise: Promise<T>, onError: (err: unknown) => F): Promise<T | F> {
  try {
    return await promise;
  } catch (err) {
    return onError(err);
  }
}
