import type { FixedWindowLimiter, Logger } from '@towerism/selfhost-kit';
import { type Principal, canSee, decideAccess } from '../../shared/access/access';
import type { DirectoryService } from '../modules/directory';
import type { CommandDefinition } from '../modules/discord/port';
import { ServiceError } from '../modules/errors';
import type { ProvisioningService } from '../modules/provisioning';
import type { CommandHandler } from './router';

/** The guild commands the bot registers at start (§8). */
export const BOT_COMMANDS: readonly CommandDefinition[] = [
  {
    name: 'link',
    description: 'Claim your Play! Pokémon player ID; an organizer confirms it.',
    options: [{ name: 'player-id', description: 'Your player ID (digits only)', type: 'string', required: true }],
  },
];

export const DAY_SYNC_PREFIX = 'genie:day-sync:';

export interface BotAccess {
  ownerId: string | null;
  organizerRoleId: string | null;
  headJudgeRoleId: string | null;
  allowlist: { enabled: boolean; userIds: readonly string[] };
}

/**
 * The Discord-side twin of the routes (§8). Every click and command is authorized from Genie's own data
 * through `decideAccess`/`canSee` (ADR-0010), never from Discord's command permissions alone.
 */
export function createBotHandlers(opts: {
  directory: DirectoryService;
  provisioning: ProvisioningService;
  access: () => BotAccess;
  /** `/link` calls per user (5 per 10 minutes). */
  linkLimiter: FixedWindowLimiter;
  logger: Logger;
}) {
  const { directory, provisioning, access, linkLimiter, logger } = opts;

  const link: CommandHandler = async (interaction, reply) => {
    if (!linkLimiter.hit(interaction.userId).allowed) {
      await reply.ephemeral('Too many tries. Wait a few minutes.');
      return;
    }
    const playerId = String(interaction.options['player-id'] ?? '').trim();
    const outcome = directory.claim({ userId: interaction.userId, playerId, displayName: interaction.userDisplayName });
    const text = {
      invalid: "That isn't a player ID: use digits only.",
      taken: 'That player ID is already taken. Ask an organizer.',
      recorded: 'Claim recorded. An organizer will confirm it on the Staff page.',
      already_linked: `You're already linked as ${outcome.outcome === 'already_linked' ? outcome.name : ''}.`,
    }[outcome.outcome];
    await reply.ephemeral(text);
  };

  const daySync: CommandHandler = async (interaction, reply) => {
    const dayId = Number(interaction.name.slice(DAY_SYNC_PREFIX.length));
    const a = access();
    const member = { userId: interaction.userId, roleIds: interaction.memberRoleIds };
    const holdsHeadJudgeRole = a.headJudgeRoleId !== null && member.roleIds.includes(a.headJudgeRoleId);
    const decision = decideAccess({ userId: interaction.userId, member, ownerId: a.ownerId, organizerRoleId: a.organizerRoleId, allowlist: a.allowlist, dayHeadJudge: false });
    const organizer = decision.allowed;

    // Authorization first, so the day's state isn't revealed to anyone else.
    let allowed = organizer;
    if (!allowed && Number.isInteger(dayId)) {
      const principal: Principal = { userId: interaction.userId, grant: 'event_head_judge', holdsHeadJudgeRole };
      try {
        allowed = canSee(principal, { kind: 'day', action: 'sync' }, provisioning.accessPlan(dayId, principal));
      } catch (err) {
        if (!(err instanceof ServiceError)) throw err;
      }
    }
    if (!allowed) {
      await reply.ephemeral("Only this day's head judges and organizers can sync.");
      return;
    }
    try {
      const { jobId, coalesced } = provisioning.sync(dayId);
      logger.info('Sync from the panel.', { dayId, jobId, coalesced, userId: interaction.userId });
      await reply.ephemeral('Sync queued.');
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      await reply.ephemeral("This day isn't open.");
    }
  };

  return { commands: { link }, components: { [DAY_SYNC_PREFIX]: daySync } };
}
