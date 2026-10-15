import { silentLogger } from '@towerism/selfhost-kit';
import type { BlueprintInput, EventRole } from '../../shared/blueprints';
import type { StaffMember } from '../../server/modules/directory';
import type { EventView } from '../../server/modules/event-days';
import { type PenaltiesService, type RecordInput, createPenaltiesService } from '../../server/modules/penalties';
import { createSetupStore } from '../../server/modules/setup/store';
import { BOT_TOKEN } from './discord-world';
import { PEOPLE, type ProvisioningWorld, provisioningWorld } from './provisioning-world';

export interface PenaltyWorld extends ProvisioningWorld {
  penalties: PenaltiesService;
  dayId: number;
  /** `Cup` (TCG, tournament `26-10-000123`) and `Cup VGC`. */
  tcg: EventView;
  vgc: EventView;
  /** TCG: Ash judge `00123`, Brock head judge `00456`, Dawn scorekeeper without a player ID. VGC: Misty judge `00789`, Gary head judge `00999`. */
  people: { ash: StaffMember; brock: StaffMember; dawn: StaffMember; misty: StaffMember; gary: StaffMember };
  categoryId(label: string, season?: string): number;
  typeId(label: string, season?: string): number;
  /** A valid recording by Ash on the TCG event; override what the test is about. */
  recordInput(over?: Partial<RecordInput>): RecordInput;
  /** Puts Tracey (the fake's `outsider` member, player ID `00777`) on the day's staff as streaming on `eventId`, keeping everyone else's roles. */
  addStreamer(eventId: number): StaffMember;
  /** Sets one staffer's role on one event, keeping everything else. */
  setRole(staffMemberId: number, eventId: number, role: EventRole): void;
  /** The penalties' messages in the fake, by channel name. */
  messagesIn(channelName: string): ReturnType<ProvisioningWorld['discord']['messages']['get']>[];
}

/** An open, provisioned day (the default blueprint unless given) with two events, their staff and the seeded catalog. */
export async function penaltyWorld(opts: { blueprint?: BlueprintInput; beforeInsert?: (key: string) => void } = {}): Promise<PenaltyWorld> {
  const w = provisioningWorld();
  const store = createSetupStore(w.database.db);
  const penalties = createPenaltiesService({
    db: w.database.db,
    clock: w.clock,
    logger: silentLogger,
    eventDays: w.days,
    directory: w.directory,
    provisioning: w.provisioning,
    gateway: () => w.discord.create(BOT_TOKEN).gateway,
    season: { current: () => store.currentSeason(), put: (season, now) => store.putCurrentSeason(season, now) },
    ...(opts.beforeInsert ? { testHooks: { beforeInsert: opts.beforeInsert } } : {}),
  });

  w.referencedBy.push((id) => penalties.namesJudge(id));
  const person = (displayName: string, discordUserId: string, playerId: string | null) => w.directory.create({ displayName, discordUserId, playerId });
  const people = {
    ash: person('Ash', PEOPLE.ash, '00123'),
    brock: person('Brock', PEOPLE.brock, '00456'),
    dawn: person('Dawn', PEOPLE.dawn, null),
    misty: person('Misty', PEOPLE.misty, '00789'),
    gary: person('Gary', PEOPLE.gary, '00999'),
  };
  const blueprintId = opts.blueprint ? w.days.createBlueprint(opts.blueprint).id : undefined;
  const { day } = w.days.createDay({ date: '2026-10-17', title: 'Saturday', ...(blueprintId === undefined ? {} : { blueprintId }) });
  const tcg = w.days.addEvent(day.id, { name: 'Cup', game: 'tcg', startTime: '10:00', tournamentId: '26-10-000123' });
  const vgc = w.days.addEvent(day.id, { name: 'Cup VGC', game: 'vgc', startTime: '11:00' });
  w.days.putStaff(day.id, [
    { staffMemberId: people.ash.id, events: [{ eventId: tcg.id, role: 'judge' }] },
    { staffMemberId: people.brock.id, events: [{ eventId: tcg.id, role: 'headjudge' }] },
    { staffMemberId: people.dawn.id, events: [{ eventId: tcg.id, role: 'scorekeeper' }] },
    { staffMemberId: people.misty.id, events: [{ eventId: vgc.id, role: 'judge' }] },
    { staffMemberId: people.gary.id, events: [{ eventId: vgc.id, role: 'headjudge' }] },
  ]);
  await w.provisioning.open(day.id);
  await w.jobs.runDue();

  const idOf = (table: 'penalty_category' | 'penalty_type', label: string, season: string) =>
    (w.database.sqlite.prepare(`SELECT id FROM ${table} WHERE season = ? AND label = ?`).pluck().get(season, label) as number | undefined) ??
    (() => {
      throw new Error(`No ${table} ${label} in ${season}`);
    })();
  let keys = 0;
  function setRole(staffMemberId: number, eventId: number, role: EventRole) {
    const staff = w.days.plan(day.id).staff.map((s) => ({ staffMemberId: s.staffMemberId, events: s.events.filter((e) => !(s.staffMemberId === staffMemberId && e.eventId === eventId)) }));
    const mine = staff.find((s) => s.staffMemberId === staffMemberId);
    if (mine) mine.events.push({ eventId, role });
    else staff.push({ staffMemberId, events: [{ eventId, role }] });
    w.days.putStaff(day.id, staff);
  }
  return {
    ...w,
    penalties,
    dayId: day.id,
    tcg,
    vgc,
    people,
    categoryId: (label, season = '2026-27') => idOf('penalty_category', label, season),
    typeId: (label, season = '2026-27') => idOf('penalty_type', label, season),
    recordInput: (over = {}) => ({
      dayId: day.id,
      eventId: tcg.id,
      key: `web:00000000-0000-4000-8000-${String(++keys).padStart(12, '0')}`,
      round: 3,
      competitorPlayerId: '0012345',
      categoryId: idOf('penalty_category', 'Game Play', '2026-27'),
      severity: 'Minor',
      penaltyTypeId: idOf('penalty_type', 'Warning', '2026-27'),
      notes: 'Drew an extra card.',
      judgeStaffMemberId: people.ash.id,
      recordedBy: PEOPLE.ash,
      ...over,
    }),
    addStreamer: (eventId) => {
      const tracey = person('Tracey', PEOPLE.outsider, '00777');
      setRole(tracey.id, eventId, 'streaming');
      return tracey;
    },
    setRole,
    messagesIn: (name) => {
      const channel = w.channel(name);
      return [...w.discord.messages.values()].filter((m) => m.channelId === channel.id);
    },
  };
}

