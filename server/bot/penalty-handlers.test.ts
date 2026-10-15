import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BLUEPRINT } from '../../shared/blueprints';
import { EDIT_WINDOW_MS } from '../../shared/penalties';
import { BOT_TOKEN, IDS } from '../../test/support/discord-world';
import { recordingLogger } from '../../test/support/logger';
import { type PenaltyWorld, penaltyWorld } from '../../test/support/penalty-world';
import { PEOPLE } from '../../test/support/provisioning-world';
import type { InboundInteraction, ModalSpec } from '../modules/discord/port';
import { PENALTY_COMMANDS, createPenaltyHandlers } from './penalty-handlers';
import { createInteractionRouter } from './router';

let w: PenaltyWorld;
const CLOSED = 'This day is closed. Corrections are made on the website.';
let logger: ReturnType<typeof recordingLogger>;
let ids = 700_000_000_000_000_000n;
afterEach(() => w?.close());

async function world(opts: Parameters<typeof penaltyWorld>[0] = {}) {
  w = await penaltyWorld(opts);
  logger = recordingLogger();
  const handlers = createPenaltyHandlers({
    penalties: w.penalties,
    provisioning: w.provisioning,
    eventDays: w.days,
    directory: w.directory,
    access: () => ({ ownerId: IDS.owner, organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole, allowlist: { enabled: false, userIds: [] } }),
    clock: w.clock,
  });
  const router = createInteractionRouter({ boundGuildId: () => IDS.guild, logger, commands: handlers.commands, components: handlers.components, modals: handlers.modals, autocomplete: handlers.autocomplete });
  await w.discord.create(BOT_TOKEN).bot.connect({ onInteraction: (i, reply) => router.route(i, reply) });
}

const roles = (userId: string) => (userId === PEOPLE.organizer ? [IDS.organizerRole] : []);
const base = (userId: string, channelName: string | null): Omit<InboundInteraction, 'kind' | 'name'> => ({
  id: String(++ids),
  guildId: IDS.guild,
  channelId: channelName === null ? '600000000000000999' : w.channel(channelName).id,
  userId,
  options: {},
  memberRoleIds: roles(userId),
  userDisplayName: 'Someone',
});
const slash = (name: 'penalty' | 'penalties', userId: string, channel: string | null, options: InboundInteraction['options'] = {}) =>
  w.discord.interact({ ...base(userId, channel), kind: 'command', name, options });
const submit = (customId: string, userId: string, channel: string, fields: Record<string, string | string[]>) =>
  w.discord.interact({ ...base(userId, channel), kind: 'modal', name: customId, fields });
const click = (customId: string, userId: string) => w.discord.interact({ ...base(userId, 'cup-penalties'), kind: 'component', name: customId });

const select = (modal: ModalSpec, id: string) => {
  const c = modal.components.find((x) => x.customId === id);
  if (c?.kind !== 'select') throw new Error(`no select ${id}`);
  return c.options;
};
const valueOf = (modal: ModalSpec, id: string, label: string) => select(modal, id).find((o) => o.label === label)!.value;
const fill = (modal: ModalSpec, over: Record<string, string | string[]> = {}) => ({
  category: [valueOf(modal, 'category', 'Game Play')],
  severity: ['Major'],
  penaltyType: [valueOf(modal, 'penaltyType', 'GL')],
  competitorPlayerId: '0012345',
  notes: 'Drew an extra card.',
  ...over,
});
const count = () => w.database.sqlite.prepare('SELECT count(*) FROM penalty').pluck().get();

describe('/penalty', () => {
  it('registers /penalty and /penalties with their options', () => {
    expect(PENALTY_COMMANDS).toEqual([
      {
        name: 'penalty',
        description: expect.any(String),
        options: [
          { name: 'round', description: expect.any(String), type: 'integer', required: true, minValue: 1, maxValue: 99 },
          { name: 'event', description: expect.any(String), type: 'string', required: false, autocomplete: true },
        ],
      },
      { name: 'penalties', description: expect.any(String), options: [{ name: 'event', description: expect.any(String), type: 'string', required: false, autocomplete: true }] },
    ]);
  });

  it('opens the modal from the database alone, then records once, posts the card and answers', async () => {
    await world();
    const before = w.discord.restCalls;
    const opened = await slash('penalty', PEOPLE.ash, 'cup-penalties', { round: 3 });
    expect(w.discord.restCalls).toBe(before);
    const modal = opened.modal!;
    expect(modal.customId).toMatch(new RegExp(`^genie:penalty:\\d+:${w.tcg.id}:3$`));
    expect(modal.title).toBe('Penalty · Cup · Round 3');
    expect(modal.components.map((c) => [c.kind, c.customId])).toEqual([
      ['select', 'category'],
      ['select', 'severity'],
      ['select', 'penaltyType'],
      ['text', 'competitorPlayerId'],
      ['text', 'notes'],
    ]);
    expect(select(modal, 'penaltyType').map((o) => o.label)).toEqual(['Warning', 'DPC', 'QPC', 'GL', 'DQ']);
    expect(select(modal, 'severity').map((o) => o.value)).toEqual(['Minor', 'Major', 'Severe']);
    expect(modal.components[3]).toMatchObject({ style: 'short', minLength: 1, maxLength: 10, required: true });
    expect(modal.components[4]).toMatchObject({ style: 'paragraph', minLength: 0, maxLength: 1000, required: false });

    const done = await submit(modal.customId, PEOPLE.ash, 'cup-penalties', fill(modal));
    expect(done).toMatchObject({ deferred: true, ephemeral: ['Recorded #1 for Cup.'] });
    const row = w.database.sqlite.prepare('SELECT round, severity, idempotency_key AS k FROM penalty').get();
    expect(row).toEqual({ round: 3, severity: 'Major', k: `discord:${modal.customId.split(':')[2]}` });
    expect(w.messagesIn('cup-penalties')).toHaveLength(1);

    expect((await submit(modal.customId, PEOPLE.ash, 'cup-penalties', fill(modal))).ephemeral).toEqual(['Already recorded as #1.']);
    expect(count()).toBe(1);
  });

  it('cuts a long modal title to 45 characters', async () => {
    await world();
    w.days.patchEvent(w.dayId, w.tcg.id, { name: 'A very long tournament name that goes on' });
    const opened = await slash('penalty', PEOPLE.ash, 'cup-penalties', { round: 12 });
    expect(opened.modal!.title).toHaveLength(45);
  });

  it('resolves the event from the channel, and refuses every wrong place or caller with its own answer', async () => {
    await world();
    const reply = async (userId: string, channel: string | null, options: InboundInteraction['options'] = {}) => (await slash('penalty', userId, channel, { round: 1, ...options })).ephemeral;
    expect(await reply(PEOPLE.ash, 'day-staff')).toEqual(['Pick the event.']);
    expect((await slash('penalty', PEOPLE.ash, 'day-staff', { round: 1, event: String(w.tcg.id) })).modal?.customId).toContain(`:${w.tcg.id}:1`);
    expect(await reply(PEOPLE.ash, 'day-staff', { event: '999999' })).toEqual(['Pick the event.']);
    expect(await reply(PEOPLE.ash, 'cup-floor')).toEqual([`Record penalties in <#${w.channel('cup-penalties').id}>.`]);
    expect(await reply(PEOPLE.ash, 'cup-penalties', { event: String(w.vgc.id) })).toEqual(['This channel belongs to Cup.']);
    expect(await reply(PEOPLE.ash, null)).toEqual(["Run this in a day's channel."]);
    expect(await reply(PEOPLE.misty, 'day-staff', { event: String(w.tcg.id) })).toEqual(["You're not on Cup's staff."]);
    expect(await reply(PEOPLE.organizer, 'cup-penalties')).toEqual(["You're not on Cup's staff. Record it on the website."]);
    expect(await reply(PEOPLE.dawn, 'cup-penalties')).toEqual(['Link your player ID first: `/link player-id:`.']);
    w.directory.claim({ userId: PEOPLE.outsider, playerId: '5555', displayName: 'Outsider' });
    expect(await reply(PEOPLE.outsider, 'day-staff', { event: String(w.tcg.id) })).toEqual(["An organizer hasn't confirmed your link yet."]);
    expect(await reply(PEOPLE.ash, 'cup-penalties', { round: 100 })).toEqual(['Round: a whole number from 1 to 99.']);

    w.database.sqlite.prepare("UPDATE penalty_type SET active = 0 WHERE label IN ('Warning', 'GL', 'DQ')").run();
    expect(await reply(PEOPLE.misty, 'cup-vgc-penalties')).toEqual(['No penalties are set up for vgc this season. Ask an organizer.']);
  });

  it('refuses a day that isn’t open', async () => {
    await world();
    w.database.sqlite.prepare("UPDATE event_day SET state = 'closing'").run();
    expect((await slash('penalty', PEOPLE.ash, 'cup-penalties', { round: 1 })).ephemeral).toEqual(["Run this in a day's channel."]);
  });

  it('re-checks a submit against current data and never trusts the custom ID or the select values', async () => {
    await world();
    const modal = (await slash('penalty', PEOPLE.ash, 'cup-penalties', { round: 3 })).modal!;
    const [, , interactionId] = modal.customId.split(':');
    const forged = `genie:penalty:${interactionId}:${w.vgc.id}:3`;
    expect((await submit(forged, PEOPLE.ash, 'day-staff', fill(modal))).ephemeral).toEqual(["You're not on Cup VGC's staff."]);
    expect((await submit('genie:penalty:nope', PEOPLE.ash, 'cup-penalties', fill(modal))).ephemeral).toEqual(['This form has expired. Run /penalty again.']);
    expect((await submit(modal.customId, PEOPLE.ash, 'cup-penalties', fill(modal, { penaltyType: [String(w.typeId('DPC') + 1000)] }))).ephemeral).toEqual([
      'That penalty isn’t offered for this event.',
    ]);
    expect((await submit(modal.customId, PEOPLE.ash, 'cup-penalties', fill(modal, { competitorPlayerId: '12a' }))).ephemeral).toEqual([
      "Competitor's player ID: digits only, up to 10.",
    ]);
    w.database.sqlite.prepare("UPDATE event_day SET state = 'closing'").run();
    expect((await submit(modal.customId, PEOPLE.ash, 'cup-penalties', fill(modal))).ephemeral).toEqual(["Run this in a day's channel."]);
    expect(count()).toBe(0);
  });

  it('says so when no card could be posted', async () => {
    await world();
    const modal = (await slash('penalty', PEOPLE.ash, 'cup-penalties', { round: 3 })).modal!;
    w.discord.failNext('unavailable');
    expect((await submit(modal.customId, PEOPLE.ash, 'cup-penalties', fill(modal))).ephemeral).toEqual([
      "Recorded #1 for Cup. The card couldn't be posted; a head judge can repost it on the website.",
    ]);
  });

  it('says no card was posted when the event has no channel of its own, and posts none in a day-wide channel', async () => {
    await world({ blueprint: { ...DEFAULT_BLUEPRINT, name: 'Day-wide only', channels: DEFAULT_BLUEPRINT.channels.filter((c) => c.scope === 'day') } });
    const before = w.discord.messages.size;
    const modal = (await slash('penalty', PEOPLE.ash, 'day-staff', { round: 2, event: String(w.tcg.id) })).modal!;
    expect((await submit(modal.customId, PEOPLE.ash, 'day-staff', fill(modal))).ephemeral).toEqual(['Recorded #1 for Cup. No card was posted: this event has no channel for it.']);
    expect(w.discord.messages.size).toBe(before);
  });

  it('answers a submit with the same key from someone else as unusable, revealing nothing', async () => {
    await world();
    const modal = (await slash('penalty', PEOPLE.ash, 'day-staff', { round: 3, event: String(w.tcg.id) })).modal!;
    await submit(modal.customId, PEOPLE.ash, 'day-staff', fill(modal));
    expect((await submit(modal.customId, PEOPLE.brock, 'day-staff', fill(modal))).ephemeral).toEqual(["This form can't be used. Run /penalty again."]);
  });
});

describe('autocomplete for event', () => {
  it('offers the open day’s events the caller is on, matching what they typed, and nothing elsewhere', async () => {
    await world();
    const complete = async (userId: string, channel: string | null, value: string) =>
      (await w.discord.interact({ ...base(userId, channel), kind: 'autocomplete', name: 'penalty', focused: { name: 'event', value } })).choices;
    expect(await complete(PEOPLE.ash, 'day-staff', 'cu')).toEqual([{ name: 'Cup', value: String(w.tcg.id) }]);
    expect(await complete(PEOPLE.organizer, 'day-staff', 'CU')).toEqual([
      { name: 'Cup', value: String(w.tcg.id) },
      { name: 'Cup VGC', value: String(w.vgc.id) },
    ]);
    expect(await complete(PEOPLE.organizer, 'day-staff', 'vgc')).toEqual([{ name: 'Cup VGC', value: String(w.vgc.id) }]);
    expect(await complete(PEOPLE.ash, null, '')).toEqual([]);
  });

  it('drops an autocomplete and a modal submit from another guild or a DM', async () => {
    await world();
    for (const guildId of ['400000000000000009', null]) {
      const auto = await w.discord.interact({ ...base(PEOPLE.ash, 'day-staff'), guildId, kind: 'autocomplete', name: 'penalty', focused: { name: 'event', value: '' } });
      const modal = await w.discord.interact({ ...base(PEOPLE.ash, 'day-staff'), guildId, kind: 'modal', name: `genie:penalty:1:${w.tcg.id}:1`, fields: {} });
      expect([auto.choices, auto.ephemeral, modal.ephemeral]).toEqual([null, [], []]);
    }
    expect(logger.records.filter((r) => r.msg === 'interaction_dropped')).toHaveLength(4);
  });
});

describe('/penalties', () => {
  it('lists the 20 newest active penalties without notes, then points to the website', async () => {
    await world();
    for (let i = 0; i < 26; i++) await w.penalties.record(w.recordInput({ round: (i % 9) + 1 }));
    const first = w.penalties.list(w.dayId, [w.tcg.id])[0]!;
    await w.penalties.voidPenalty(w.dayId, first.id, { reason: 'dup', expectedRevision: 1, by: PEOPLE.brock });
    const [text] = (await slash('penalties', PEOPLE.ash, 'cup-floor')).ephemeral;
    const lines = text!.split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe('#26 · R8 · 0012345 · Game Play · Minor · Warning');
    expect(lines.at(-1)).toBe('…and 5 more on the website.');
    expect(text).not.toContain('Drew an extra card');
    expect(text!.length).toBeLessThanOrEqual(1900);
  });

  it('answers who may not list, and an event with none', async () => {
    await world();
    expect((await slash('penalties', PEOPLE.misty, 'cup-floor')).ephemeral).toEqual(["You're not on Cup's staff."]);
    expect((await slash('penalties', PEOPLE.misty, 'cup-vgc-floor')).ephemeral).toEqual(['No penalties yet.']);
    w.close();
    const hjOnly = DEFAULT_BLUEPRINT.channels.map((c) => (c.key === 'penalties' ? { ...c, audience: 'head_judges' as const } : c));
    await world({ blueprint: { ...DEFAULT_BLUEPRINT, name: 'HJ penalties', channels: hjOnly } });
    expect((await slash('penalties', PEOPLE.dawn, 'cup-floor')).ephemeral).toEqual(["You can't list Cup's penalties."]);
    // Recording stays open to the event's staff; the redirect names a channel only to those who can see it.
    expect((await slash('penalty', PEOPLE.ash, 'cup-floor', { round: 1 })).modal).not.toBeNull();
  });
});

describe('the card’s Edit and Void', () => {
  async function recorded() {
    await world();
    const modal = (await slash('penalty', PEOPLE.ash, 'cup-penalties', { round: 3 })).modal!;
    await submit(modal.customId, PEOPLE.ash, 'cup-penalties', fill(modal));
    return w.penalties.list(w.dayId, [w.tcg.id])[0]!;
  }

  it('lets the judge edit within 15 minutes with the current values filled in, then only head judges', async () => {
    const p = await recorded();
    w.clock.advance(10 * 60_000);
    const opened = await click(`genie:penalty-edit:${p.id}`, PEOPLE.ash);
    const modal = opened.modal!;
    expect(modal.customId).toBe(`genie:penalty-edit:${p.id}:1`);
    expect(select(modal, 'severity').find((o) => o.default)?.value).toBe('Major');
    expect(select(modal, 'penaltyType').find((o) => o.default)?.label).toBe('GL');
    expect(modal.components.find((c) => c.customId === 'competitorPlayerId')).toMatchObject({ value: '0012345' });

    const saved = await submit(modal.customId, PEOPLE.ash, 'cup-penalties', fill(modal, { severity: ['Severe'] }));
    expect(saved).toMatchObject({ deferred: true, ephemeral: ['Edited #1.'] });
    expect(w.penalties.get(p.id)).toMatchObject({ revision: 2, severity: 'Severe' });
    expect(w.messagesIn('cup-penalties')[0]!.embed!.footer).toBe('Cup · Edited by Ash · revision 2');

    w.clock.advance(EDIT_WINDOW_MS);
    expect((await click(`genie:penalty-edit:${p.id}`, PEOPLE.ash)).ephemeral).toEqual(['Your 15 minutes to edit are up. Ask a head judge.']);
    expect((await click(`genie:penalty-void:${p.id}`, PEOPLE.ash)).ephemeral).toEqual(["You can't edit this penalty."]);
    expect((await click(`genie:penalty-edit:${p.id}`, PEOPLE.gary)).ephemeral).toEqual(["You can't edit this penalty."]);
    expect((await click('genie:penalty-edit:999999', PEOPLE.gary)).ephemeral).toEqual(["You can't edit this penalty."]);
    expect((await click(`genie:penalty-edit:${p.id}`, PEOPLE.brock)).modal).not.toBeNull();
  });

  it('refuses a stale form, a voided penalty and a day that isn’t open, each with its own answer', async () => {
    const p = await recorded();
    const stale = (await click(`genie:penalty-edit:${p.id}`, PEOPLE.brock)).modal!;
    await w.penalties.edit(w.dayId, p.id, { round: 4 }, { expectedRevision: 1, by: PEOPLE.brock });
    expect((await submit(stale.customId, PEOPLE.brock, 'cup-penalties', fill(stale, { severity: ['Minor'] }))).ephemeral).toEqual([
      'Someone changed #1 since you opened this. Open Edit again.',
    ]);
    const fresh = (await click(`genie:penalty-edit:${p.id}`, PEOPLE.brock)).modal!;
    expect((await submit(fresh.customId, PEOPLE.brock, 'cup-penalties', fill(fresh))).ephemeral).toEqual(['Edited #1.']);
    expect(w.penalties.get(p.id)!.revision).toBe(2);

    const voidForm = (await click(`genie:penalty-void:${p.id}`, PEOPLE.brock)).modal!;
    expect(voidForm).toMatchObject({ customId: `genie:penalty-void:${p.id}:2`, components: [{ kind: 'text', customId: 'reason', minLength: 1, maxLength: 500, required: true }] });
    expect((await submit(voidForm.customId, PEOPLE.brock, 'cup-penalties', { reason: 'duplicate' })).ephemeral).toEqual(['Voided #1.']);
    const card = w.messagesIn('cup-penalties')[0]!;
    expect(card.embed!.title).toBe('VOIDED · Penalty #1 · Round 4');
    expect(card.buttons).toEqual([]);
    expect((await submit(fresh.customId, PEOPLE.brock, 'cup-penalties', fill(fresh))).ephemeral).toEqual(['#1 was voided.']);
    expect((await click(`genie:penalty-edit:${p.id}`, PEOPLE.brock)).ephemeral).toEqual(['#1 was voided.']);

    const other = await w.penalties.record(w.recordInput());
    const form = (await click(`genie:penalty-edit:${other.penalty.id}`, PEOPLE.brock)).modal!;
    w.database.sqlite.prepare("UPDATE event_day SET state = 'closing'").run();
    expect((await submit(form.customId, PEOPLE.brock, 'cup-penalties', fill(form))).ephemeral).toEqual([CLOSED]);
  });

  it('changes nothing from the card once the day is closed, whoever clicks or submits', async () => {
    const p = await recorded();
    const form = (await click(`genie:penalty-edit:${p.id}`, PEOPLE.brock)).modal!;
    w.days.markClosing(w.dayId, PEOPLE.brock, () => 0);
    w.days.markClosed(w.dayId, w.clock.now());
    for (const who of [PEOPLE.brock, PEOPLE.organizer]) {
      expect((await click(`genie:penalty-edit:${p.id}`, who)).ephemeral).toEqual([CLOSED]);
      expect((await click(`genie:penalty-void:${p.id}`, who)).ephemeral).toEqual([CLOSED]);
      expect((await submit(form.customId, who, 'cup-penalties', fill(form))).ephemeral).toEqual([CLOSED]);
      expect((await submit(`genie:penalty-void:${p.id}:1`, who, 'cup-penalties', { reason: 'x' })).ephemeral).toEqual([CLOSED]);
    }
    expect(w.penalties.get(p.id)).toMatchObject({ revision: 1, state: 'active' });
  });

  it('re-checks the right at submit time', async () => {
    const p = await recorded();
    const form = (await click(`genie:penalty-edit:${p.id}`, PEOPLE.ash)).modal!;
    w.clock.advance(EDIT_WINDOW_MS + 1);
    expect((await submit(form.customId, PEOPLE.ash, 'cup-penalties', fill(form))).ephemeral).toEqual(["You can't edit this penalty."]);
    expect((await submit(`genie:penalty-void:${p.id}:1`, PEOPLE.ash, 'cup-penalties', { reason: 'x' })).ephemeral).toEqual(["You can't edit this penalty."]);
    expect(w.penalties.get(p.id)).toMatchObject({ revision: 1, state: 'active' });
  });
});
