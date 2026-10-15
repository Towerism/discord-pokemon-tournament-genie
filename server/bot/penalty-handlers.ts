/**
 * `/penalty`, `/penalties` and the card's Edit and Void (§6.4, §8, ADR-0014). Every interaction is authorized from
 * Genie's own data through `canSee`/`editRight` (ADR-0010), and every submit is checked again against current data:
 * custom IDs and modal values are untrusted.
 */
import type { Clock } from '@towerism/selfhost-kit';
import { type AccessPlan, type Principal, canSee, decideAccess, isOrganizer } from '../../shared/access/access';
import { NOTES_MAX, ROUND_MAX, SEVERITIES, VOID_REASON_MAX, editRight } from '../../shared/penalties';
import type { DirectoryService } from '../modules/directory';
import type { CommandDefinition, InboundInteraction, ModalSpec } from '../modules/discord/port';
import { ServiceError } from '../modules/errors';
import type { EventDaysService, EventView } from '../modules/event-days';
import type { PenaltiesService, PenaltyView } from '../modules/penalties';
import { EDIT_PREFIX, VOID_PREFIX } from '../modules/penalties/card';
import type { ProvisioningService } from '../modules/provisioning';
import type { BotAccess } from './handlers';
import type { CommandHandler } from './router';

const EVENT_OPTION = { name: 'event', description: 'The event (in a day-wide channel)', type: 'string', required: false, autocomplete: true } as const;

/** The guild commands for penalties (§8). */
export const PENALTY_COMMANDS: readonly CommandDefinition[] = [
  {
    name: 'penalty',
    description: 'Record a penalty for this event.',
    options: [{ name: 'round', description: 'Round of issue (top cut keeps counting)', type: 'integer', required: true, minValue: 1, maxValue: ROUND_MAX }, { ...EVENT_OPTION }],
  },
  { name: 'penalties', description: 'List this event’s penalties so far.', options: [{ ...EVENT_OPTION }] },
];

export const RECORD_PREFIX = 'genie:penalty:';
const RECORD_ID = /^genie:penalty:(\d{1,20}):(\d{1,10}):(\d{1,2})$/;
const CHANGE_ID = /^genie:penalty-(edit|void):(\d{1,10})(?::(\d{1,10}))?$/;
const MODAL_TITLE_MAX = 45;
const LIST_LINES = 20;
const LIST_CHARS = 1900;

const CANT_EDIT = "You can't edit this penalty.";
const NOT_A_DAY = "Run this in a day's channel.";
const CARD_FAILED = " The card couldn't be posted; a head judge can repost it on the website.";
const CARD_NONE = ' No card was posted: this event has no channel for it.';

type Plan = ReturnType<EventDaysService['plan']>;
type Located = { plan: Plan; access: AccessPlan; event: EventView; channel: { eventId: number | null; key: string } };

export function createPenaltyHandlers(opts: {
  penalties: PenaltiesService;
  provisioning: ProvisioningService;
  eventDays: EventDaysService;
  directory: DirectoryService;
  access: () => BotAccess;
  clock: Clock;
}) {
  const { penalties, provisioning, eventDays, directory, access, clock } = opts;

  /** The caller as `canSee` knows them: an organizer by grant, anyone else by their place in the day's plan. */
  function principalOf(i: InboundInteraction): Principal {
    const a = access();
    const member = { userId: i.userId, roleIds: i.memberRoleIds };
    const decision = decideAccess({ userId: i.userId, member, ownerId: a.ownerId, organizerRoleId: a.organizerRoleId, allowlist: a.allowlist, dayHeadJudge: false });
    const holdsHeadJudgeRole = a.headJudgeRoleId !== null && member.roleIds.includes(a.headJudgeRoleId);
    return { userId: i.userId, grant: decision.allowed ? decision.grant : 'event_head_judge', holdsHeadJudgeRole };
  }

  /** The open day a channel belongs to, or `null` ("Run this in a day's channel."). */
  function dayOfChannel(channelId: string | null) {
    const owner = channelId === null ? null : provisioning.channelOwner(channelId);
    if (!owner) return null;
    const plan = eventDays.plan(owner.dayId);
    return plan.day.state === 'open' ? { owner, plan } : null;
  }

  /** The event from the channel, or from the `event` option in a day-wide channel. A string answers the caller. */
  function locate(i: InboundInteraction, principal: Principal, eventOption: string | null): Located | string {
    const found = dayOfChannel(i.channelId);
    if (!found) return NOT_A_DAY;
    const { owner, plan } = found;
    const accessPlan = provisioning.accessPlan(plan.day.id, principal);
    let ev: EventView | undefined;
    if (owner.eventId !== null) {
      ev = plan.events.find((e) => e.id === owner.eventId);
      if (!ev) return NOT_A_DAY;
      if (eventOption !== null && eventOption !== String(ev.id)) return `This channel belongs to ${ev.name}.`;
    } else {
      ev = plan.events.find((e) => String(e.id) === eventOption);
      if (!ev) return 'Pick the event.';
    }
    return { plan, access: accessPlan, event: ev, channel: { eventId: owner.eventId, key: owner.key } };
  }

  const optionText = (i: InboundInteraction, name: string) => {
    const v = i.options[name];
    return v === undefined ? null : String(v);
  };

  /** On the event's staff only for streaming (ADR-0015): such staff aren't judges, and are told so. Organizers always may. */
  function streamsFor(at: Located, principal: Principal): boolean {
    if (isOrganizer(principal.grant)) return false;
    const staffer = at.access.staff.find((s) => s.discordUserId === principal.userId);
    return staffer !== undefined && staffer.staffOf.includes(at.event.id) && !staffer.judgeOf.includes(at.event.id);
  }
  const streamingRefusal = (at: Located, what: 'record' | 'list') => `You're on ${at.event.name}'s staff for streaming, so you can't ${what} penalties.`;

  /** Who may record here, in order: judging the event, a player ID, something to offer. A string answers the caller. */
  function recordCheck(i: InboundInteraction, principal: Principal, at: Located): string | null {
    if (streamsFor(at, principal)) return streamingRefusal(at, 'record');
    const staffer = at.access.staff.find((s) => s.discordUserId === i.userId);
    const onStaff = staffer?.staffOf.includes(at.event.id) ?? false;
    if (!canSee(principal, { kind: 'event_penalties', eventId: at.event.id, action: 'record' }, at.access) || !onStaff) {
      const claimed = directory.list().some((s) => s.linkState === 'claimed' && s.claimedDiscordUserId === i.userId);
      if (claimed && !directory.byDiscordUser(i.userId)) return "An organizer hasn't confirmed your link yet.";
      const organizer = principal.grant !== 'event_head_judge';
      return `You're not on ${at.event.name}'s staff.${organizer ? ' Record it on the website.' : ''}`;
    }
    if (!directory.byDiscordUser(i.userId)?.playerId) return 'Link your player ID first: `/link player-id:`.';
    const offered = penalties.options(at.plan.day.id, at.event.id);
    if (!offered.categories.length || !offered.types.length) return `No penalties are set up for ${at.event.game} this season. Ask an organizer.`;
    return null;
  }

  /** The event's penalties channel when the caller can see it, to send them there from another of the event's channels. */
  function redirect(at: Located, userId: string): string | null {
    if (at.channel.eventId === null) return null;
    const here = at.access.channels.find((c) => c.key === at.channel.key && c.eventId === at.event.id);
    if (here?.purpose === 'penalties') return null;
    const target = at.access.channels.find((c) => c.eventId === at.event.id && c.purpose === 'penalties' && c.audienceUserIds.includes(userId));
    if (!target) return null;
    const present = provisioning.channels(at.plan.day.id).find((c) => c.eventId === at.event.id && c.key === target.key && c.state === 'present');
    return present ? `Record penalties in <#${present.discordChannelId}>.` : null;
  }

  function recordModal(customId: string, title: string, dayId: number, eventId: number, current?: PenaltyView): ModalSpec {
    const offered = penalties.options(dayId, eventId);
    // An unchanged choice stays selectable even when it is no longer offered; the catalog leaves a select slot for it.
    const withCurrent = (list: { id: number; label: string }[], chosen?: { id: number; label: string }) => (chosen && !list.some((o) => o.id === chosen.id) ? [chosen, ...list] : list);
    const options = (list: { id: number; label: string }[], chosen?: { id: number }) => list.map((o) => ({ value: String(o.id), label: o.label, default: o.id === chosen?.id }));
    return {
      customId,
      title: title.slice(0, MODAL_TITLE_MAX),
      components: [
        { kind: 'select', customId: 'category', label: 'Category', options: options(withCurrent(offered.categories, current?.category), current?.category) },
        { kind: 'select', customId: 'severity', label: 'Severity', options: SEVERITIES.map((s) => ({ value: s, label: s, default: s === current?.severity })) },
        { kind: 'select', customId: 'penaltyType', label: 'Penalty', options: options(withCurrent(offered.types, current?.penaltyType), current?.penaltyType) },
        { kind: 'text', customId: 'competitorPlayerId', label: "Competitor's player ID", style: 'short', minLength: 1, maxLength: 10, required: true, ...(current ? { value: current.competitorPlayerId } : {}) },
        { kind: 'text', customId: 'notes', label: 'Notes', style: 'paragraph', minLength: 0, maxLength: NOTES_MAX, required: false, ...(current?.notes ? { value: current.notes } : {}) },
      ],
    };
  }

  const field = (i: InboundInteraction, name: string): string => {
    const v = i.fields?.[name];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };
  const choice = (i: InboundInteraction, name: string) => {
    const raw = field(i, name);
    return /^\d{1,10}$/.test(raw) ? Number(raw) : -1;
  };
  const formValues = (i: InboundInteraction) => ({
    categoryId: choice(i, 'category'),
    severity: field(i, 'severity') as (typeof SEVERITIES)[number],
    penaltyTypeId: choice(i, 'penaltyType'),
    competitorPlayerId: field(i, 'competitorPlayerId').trim(),
    notes: field(i, 'notes'),
  });

  /** A refusal of the penalties module, as the caller reads it; anything else is the router's to report. */
  function refusalText(err: unknown, n?: number): string {
    if (!(err instanceof ServiceError)) throw err;
    switch (err.code) {
      case 'idempotency_conflict':
        return "This form can't be used. Run /penalty again.";
      case 'revision_conflict':
        return `Someone changed #${n} since you opened this. Open Edit again.`;
      case 'penalty_voided':
        return `#${n} was voided.`;
      case 'day_not_open':
        return "This day isn't open.";
      case 'not_found':
        return CANT_EDIT;
      default:
        return err.message;
    }
  }
  const cardNote = (p: PenaltyView) => (p.cardState === 'failed' ? CARD_FAILED : p.cardState === 'none' ? CARD_NONE : '');

  // ---- /penalty

  const penalty: CommandHandler = async (i, reply) => {
    const principal = principalOf(i);
    const at = locate(i, principal, optionText(i, 'event'));
    if (typeof at === 'string') return reply.ephemeral(at);
    const moved = redirect(at, i.userId);
    if (moved) return reply.ephemeral(moved);
    const refused = recordCheck(i, principal, at);
    if (refused) return reply.ephemeral(refused);
    const round = i.options.round;
    if (typeof round !== 'number' || !Number.isInteger(round) || round < 1 || round > ROUND_MAX) return reply.ephemeral(`Round: a whole number from 1 to ${ROUND_MAX}.`);
    // Database reads only so far: the modal must open within Discord's 3 seconds.
    await reply.showModal(recordModal(`${RECORD_PREFIX}${i.id}:${at.event.id}:${round}`, `Penalty · ${at.event.name} · Round ${round}`, at.plan.day.id, at.event.id));
  };

  const recordSubmit: CommandHandler = async (i, reply) => {
    const parsed = RECORD_ID.exec(i.name);
    if (!parsed) return reply.ephemeral('This form has expired. Run /penalty again.');
    const [, commandId, eventId, round] = parsed as unknown as [string, string, string, string];
    await reply.deferEphemeral();
    const principal = principalOf(i);
    const at = locate(i, principal, eventId);
    if (typeof at === 'string') return reply.ephemeral(at);
    if (at.event.id !== Number(eventId)) return reply.ephemeral(`This channel belongs to ${at.event.name}.`);
    const refused = recordCheck(i, principal, at);
    if (refused) return reply.ephemeral(refused);
    const judge = directory.byDiscordUser(i.userId)!;
    try {
      const { penalty: p, created } = await penalties.record({
        dayId: at.plan.day.id,
        eventId: at.event.id,
        key: `discord:${commandId}`,
        round: Number(round),
        ...formValues(i),
        judgeStaffMemberId: judge.id,
        recordedBy: i.userId,
      });
      await reply.ephemeral(created ? `Recorded #${p.number} for ${at.event.name}.${cardNote(p)}` : `Already recorded as #${p.number}.`);
    } catch (err) {
      await reply.ephemeral(refusalText(err));
    }
  };

  // ---- the card's buttons

  /** The penalty and who the caller is to it; `null` answers "You can't edit this penalty." whatever the reason. */
  function changeContext(i: InboundInteraction, id: number) {
    const found = penalties.locate(id);
    if (!found) return null;
    const principal = principalOf(i);
    const access = provisioning.accessPlan(found.dayId, principal);
    const right = editRight({ eventId: found.penalty.eventId, judgeDiscordUserId: found.penalty.judgeDiscordUserId, recordedAt: found.penalty.recordedAt }, principal, access, clock.now());
    const isJudge = found.penalty.judgeDiscordUserId === i.userId && canSee(principal, { kind: 'event_penalties', eventId: found.penalty.eventId, action: 'record' }, access);
    const closed = ['closing', 'closed', 'purged'].includes(eventDays.plan(found.dayId).day.state);
    return { ...found, right, isJudge, closed };
  }

  /** After close only organizers correct penalties, on the website, so the CSV is written again (§6.4). */
  const CLOSED = 'This day is closed. Corrections are made on the website.';

  const editClick: CommandHandler = async (i, reply) => {
    const ctx = changeContext(i, Number(CHANGE_ID.exec(i.name)?.[2] ?? NaN));
    if (ctx?.closed) return reply.ephemeral(CLOSED);
    if (!ctx || ctx.right === null) return reply.ephemeral(ctx?.isJudge ? 'Your 15 minutes to edit are up. Ask a head judge.' : CANT_EDIT);
    if (ctx.penalty.state === 'voided') return reply.ephemeral(`#${ctx.penalty.number} was voided.`);
    const ev = eventDays.plan(ctx.dayId).events.find((e) => e.id === ctx.penalty.eventId)!;
    await reply.showModal(recordModal(`${EDIT_PREFIX}${ctx.penalty.id}:${ctx.penalty.revision}`, `Edit penalty #${ctx.penalty.number} · ${ev.name}`, ctx.dayId, ev.id, ctx.penalty));
  };

  const voidClick: CommandHandler = async (i, reply) => {
    const ctx = changeContext(i, Number(CHANGE_ID.exec(i.name)?.[2] ?? NaN));
    if (ctx?.closed) return reply.ephemeral(CLOSED);
    if (!ctx || ctx.right !== 'manage') return reply.ephemeral(CANT_EDIT);
    if (ctx.penalty.state === 'voided') return reply.ephemeral(`#${ctx.penalty.number} was voided.`);
    await reply.showModal({
      customId: `${VOID_PREFIX}${ctx.penalty.id}:${ctx.penalty.revision}`,
      title: `Void penalty #${ctx.penalty.number}`,
      components: [{ kind: 'text', customId: 'reason', label: 'Reason', style: 'paragraph', minLength: 1, maxLength: VOID_REASON_MAX, required: true }],
    });
  };

  const changeSubmit: CommandHandler = async (i, reply) => {
    const parsed = CHANGE_ID.exec(i.name);
    if (!parsed?.[3]) return reply.ephemeral(CANT_EDIT);
    const [, kind, id, revision] = parsed as unknown as [string, 'edit' | 'void', string, string];
    await reply.deferEphemeral();
    const ctx = changeContext(i, Number(id));
    if (ctx?.closed) return reply.ephemeral(CLOSED);
    if (!ctx || ctx.right === null || (kind === 'void' && ctx.right !== 'manage')) return reply.ephemeral(CANT_EDIT);
    const n = ctx.penalty.number;
    try {
      const opts = { expectedRevision: Number(revision), by: i.userId };
      const { penalty: p } =
        kind === 'edit' ? await penalties.edit(ctx.dayId, ctx.penalty.id, formValues(i), opts) : await penalties.voidPenalty(ctx.dayId, ctx.penalty.id, { ...opts, reason: field(i, 'reason') });
      const failed = p.cardState === 'failed' ? CARD_FAILED : '';
      await reply.ephemeral(`${kind === 'edit' ? 'Edited' : 'Voided'} #${n}.${failed}`);
    } catch (err) {
      await reply.ephemeral(refusalText(err, n));
    }
  };

  // ---- /penalties and autocomplete

  const list: CommandHandler = async (i, reply) => {
    const principal = principalOf(i);
    const at = locate(i, principal, optionText(i, 'event'));
    if (typeof at === 'string') return reply.ephemeral(at);
    if (streamsFor(at, principal)) return reply.ephemeral(streamingRefusal(at, 'list'));
    if (!canSee(principal, { kind: 'event_penalties', eventId: at.event.id, action: 'record' }, at.access)) return reply.ephemeral(`You're not on ${at.event.name}'s staff.`);
    if (!canSee(principal, { kind: 'event_penalties', eventId: at.event.id, action: 'list' }, at.access)) return reply.ephemeral(`You can't list ${at.event.name}'s penalties.`);
    const active = penalties
      .list(at.plan.day.id, [at.event.id])
      .filter((p) => p.state === 'active')
      .reverse();
    if (!active.length) return reply.ephemeral('No penalties yet.');
    const lines: string[] = [];
    for (const p of active) {
      const line = `#${p.number} · R${p.round} · ${p.competitorPlayerId} · ${p.category.label} · ${p.severity} · ${p.penaltyType.label}`;
      const more = `…and ${active.length - lines.length - 1} more on the website.`;
      if (lines.length === LIST_LINES || [...lines, line, more].join('\n').length > LIST_CHARS) break;
      lines.push(line);
    }
    if (lines.length < active.length) lines.push(`…and ${active.length - lines.length} more on the website.`);
    await reply.ephemeral(lines.join('\n'));
  };

  const eventChoices: CommandHandler = async (i, reply) => {
    const found = dayOfChannel(i.channelId);
    if (!found) return reply.autocomplete([]);
    const principal = principalOf(i);
    const accessPlan = provisioning.accessPlan(found.plan.day.id, principal);
    const typed = (i.focused?.value ?? '').toLowerCase();
    const choices = found.plan.events
      .filter((e) => e.name.toLowerCase().includes(typed) && canSee(principal, { kind: 'event_penalties', eventId: e.id, action: 'record' }, accessPlan))
      .sort((a, b) => a.startsAt - b.startsAt || a.name.localeCompare(b.name))
      .slice(0, 25)
      .map((e) => ({ name: e.name.slice(0, 100), value: String(e.id) }));
    await reply.autocomplete(choices);
  };

  return {
    commands: { penalty, penalties: list },
    components: { [EDIT_PREFIX]: editClick, [VOID_PREFIX]: voidClick },
    modals: { [RECORD_PREFIX]: recordSubmit, [EDIT_PREFIX]: changeSubmit, [VOID_PREFIX]: changeSubmit },
    autocomplete: { penalty: eventChoices, penalties: eventChoices },
  };
}
