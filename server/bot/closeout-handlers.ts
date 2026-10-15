import type { Logger } from '@towerism/selfhost-kit';
import { type Principal, canSee, decideAccess } from '../../shared/access/access';
import type { CloseoutService } from '../modules/closeout';
import type { InboundInteraction } from '../modules/discord/port';
import { ServiceError } from '../modules/errors';
import type { EventDaysService } from '../modules/event-days';
import type { ProvisioningService } from '../modules/provisioning';
import type { BotAccess } from './handlers';
import type { CommandHandler } from './router';

export const DAY_CLOSE_PREFIX = 'genie:day-close:';
export const DAY_CLOSE_CONFIRM_PREFIX = 'genie:day-close-confirm:';

const NOT_ALLOWED = "Only this day's head judges and organizers can close it.";
const NOT_OPEN = "This day isn't open.";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The panel's Close the day (§6.5 step 1, §8): a confirmation naming what closing leaves behind, then the close.
 * Authorized from Genie's own data through `canSee` (ADR-0010), like Sync.
 */
export function createCloseoutHandlers(opts: {
  closeout: CloseoutService;
  provisioning: ProvisioningService;
  eventDays: EventDaysService;
  access: () => BotAccess;
  logger: Logger;
}) {
  const { closeout, provisioning, eventDays, access, logger } = opts;

  /** The day, when the caller may close it; `null` for anyone else and for an unknown day alike. */
  function allowedDay(i: InboundInteraction, prefix: string): number | null {
    const raw = i.name.slice(prefix.length);
    const dayId = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(dayId)) return null;
    const a = access();
    const member = { userId: i.userId, roleIds: i.memberRoleIds };
    const organizer = decideAccess({ userId: i.userId, member, ownerId: a.ownerId, organizerRoleId: a.organizerRoleId, allowlist: a.allowlist, dayHeadJudge: false }).allowed;
    try {
      eventDays.plan(dayId);
      if (organizer) return dayId;
      const principal: Principal = { userId: i.userId, grant: 'event_head_judge', holdsHeadJudgeRole: a.headJudgeRoleId !== null && member.roleIds.includes(a.headJudgeRoleId) };
      return canSee(principal, { kind: 'day', action: 'close' }, provisioning.accessPlan(dayId, principal)) ? dayId : null;
    } catch (err) {
      if (err instanceof ServiceError) return null;
      throw err;
    }
  }

  const ask: CommandHandler = async (i, reply) => {
    const dayId = allowedDay(i, DAY_CLOSE_PREFIX);
    if (dayId === null) return reply.ephemeral(NOT_ALLOWED);
    const day = eventDays.plan(dayId).day;
    if (day.state !== 'open') return reply.ephemeral(NOT_OPEN);
    const p = closeout.preflight(dayId);
    const parts = [`Close ${day.title}? Its ${plural(p.channels, 'channel', 'channels')} will be locked and exported.`];
    if (p.recentPenalties.length) parts.push(`${plural(p.recentPenalties.length, 'penalty may', 'penalties may')} still be edited by ${p.recentPenalties.length === 1 ? 'its judge' : 'their judges'}.`);
    if (p.csvBlocked.length) parts.push(`${plural(p.csvBlocked.length, 'event has', 'events have')} no Tournament ID, so ${p.csvBlocked.length === 1 ? 'its CSV waits' : 'their CSVs wait'} for one.`);
    await reply.ephemeral(parts.join(' '), { buttons: [{ customId: `${DAY_CLOSE_CONFIRM_PREFIX}${dayId}`, label: 'Confirm close', style: 'danger' }] });
  };

  const confirm: CommandHandler = async (i, reply) => {
    const dayId = allowedDay(i, DAY_CLOSE_CONFIRM_PREFIX);
    if (dayId === null) return reply.ephemeral(NOT_ALLOWED);
    try {
      const { jobId } = await closeout.close(dayId, i.userId);
      logger.info('Close from the panel.', { dayId, jobId, userId: i.userId });
      await reply.ephemeral('Closing the day: the channels are being locked.');
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      await reply.ephemeral(['day_not_open', 'day_closed', 'close_in_progress'].includes(err.code) ? NOT_OPEN : err.message);
    }
  };

  return { components: { [DAY_CLOSE_PREFIX]: ask, [DAY_CLOSE_CONFIRM_PREFIX]: confirm } };
}
