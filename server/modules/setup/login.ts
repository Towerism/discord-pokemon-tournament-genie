import type { Clock, Logger } from '@towerism/selfhost-kit';
import { type Grant, type Member, decideAccess } from '../../../shared/access/access';
import type { CreateDiscord } from '../discord/port';
import type { SetupService } from './service';
import type { SetupStore } from './store';

/** Membership and roles are re-checked this often (ADR-0004). */
export const SESSION_REFRESH_MS = 15 * 60_000;

export interface SessionUser {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
}

export interface SessionData {
  user: SessionUser;
  grant: Grant;
  checkedAt: number;
}

export type LoginOutcome = { redirect: string; session?: SessionData };

export type RefreshOutcome =
  | { action: 'keep' }
  | { action: 'update'; grant: Grant; checkedAt: number }
  | { action: 'revoke' }
  | { action: 'unavailable' };

/**
 * What a completed Discord login means (ADR-0004). During setup it can only bind the owner, and only from the
 * session that unlocked the wizard. After setup it admits members of the bound guild who hold a grant.
 */
export function createLoginService(opts: {
  store: SetupStore;
  setup: SetupService;
  createDiscord: CreateDiscord;
  clock: Clock;
  logger: Logger;
}) {
  const { store, setup, createDiscord, clock, logger } = opts;

  /** The user's membership of the bound guild. Throws when Discord (or the stored token) can't answer. */
  async function membership(userId: string): Promise<{ member: Member | null; guildId: string }> {
    const binding = store.binding();
    if (!binding) throw new Error('No guild is bound.');
    const member = await createDiscord(setup.botToken()).gateway.getMember(binding.guildId, userId);
    return { member, guildId: binding.guildId };
  }

  async function decide(userId: string) {
    const { member } = await membership(userId);
    const binding = store.binding()!;
    return decideAccess({
      userId,
      member,
      ownerId: store.install()?.ownerDiscordUserId ?? null,
      organizerRoleId: binding.organizerRoleId,
      allowlist: { enabled: binding.organizerAllowlistEnabled, userIds: store.allowlist() },
    });
  }

  return {
    async complete(input: { user: SessionUser; unlocked: boolean }): Promise<LoginOutcome> {
      const { user, unlocked } = input;
      const now = clock.now();

      if (!setup.isComplete()) {
        if (!unlocked) return { redirect: '/login?error=setup_incomplete' };
        let outcome;
        try {
          outcome = await setup.bindOwner(user.id);
        } catch (err) {
          logger.warn('Could not check the owner’s membership.', { err });
          return { redirect: '/setup?error=discord_unavailable' };
        }
        if (outcome !== 'bound') return { redirect: `/setup?error=${outcome}` };
        store.audit(user.id, 'owner', now);
        return { redirect: '/setup', session: { user, grant: 'owner', checkedAt: now } };
      }

      let decision;
      try {
        decision = await decide(user.id);
      } catch (err) {
        logger.warn('Could not check a login against the guild.', { userId: user.id, err });
        return { redirect: '/login?error=discord_unavailable' };
      }
      if (!decision.allowed) {
        logger.info('Login refused.', { userId: user.id, reason: decision.reason });
        return { redirect: `/login?error=${decision.reason}` };
      }
      store.audit(user.id, decision.grant, now);
      logger.info('Login.', { userId: user.id, grant: decision.grant });
      return { redirect: '/', session: { user, grant: decision.grant, checkedAt: now } };
    },

    async refresh(session: SessionData): Promise<RefreshOutcome> {
      const now = clock.now();
      if (now - session.checkedAt < SESSION_REFRESH_MS) return { action: 'keep' };
      let decision;
      try {
        decision = await decide(session.user.id);
      } catch (err) {
        logger.warn('Could not re-check a session against the guild.', { userId: session.user.id, err });
        return { action: 'unavailable' };
      }
      if (!decision.allowed) {
        logger.info('Session revoked.', { userId: session.user.id, reason: decision.reason });
        return { action: 'revoke' };
      }
      return { action: 'update', grant: decision.grant, checkedAt: now };
    },
  };
}

export type LoginService = ReturnType<typeof createLoginService>;
