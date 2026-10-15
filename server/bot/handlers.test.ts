import { createFixedWindowLimiter } from '@towerism/selfhost-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDS } from '../../test/support/discord-world';
import { recordingLogger } from '../../test/support/logger';
import { PEOPLE, type ProvisioningWorld, provisioningWorld } from '../../test/support/provisioning-world';
import type { InboundInteraction } from '../modules/discord/port';
import { BOT_COMMANDS, createBotHandlers } from './handlers';
import { createInteractionRouter } from './router';

let w: ProvisioningWorld;
let route: (i: Partial<InboundInteraction>) => Promise<string[]>;

beforeEach(() => {
  w = provisioningWorld();
  const handlers = createBotHandlers({
    directory: w.directory,
    provisioning: w.provisioning,
    access: () => ({ ownerId: IDS.owner, organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole, allowlist: { enabled: false, userIds: [] } }),
    linkLimiter: createFixedWindowLimiter({ max: 5, windowMs: 10 * 60_000, clock: w.clock }),
    logger: recordingLogger(),
  });
  const router = createInteractionRouter({ boundGuildId: () => IDS.guild, logger: recordingLogger(), commands: handlers.commands, components: handlers.components });
  route = async (over) => {
    const sent: string[] = [];
    await router.route(
      {
        id: '500000000000000001',
        kind: 'command',
        name: 'link',
        guildId: IDS.guild,
        channelId: '600000000000000001',
        userId: PEOPLE.ash,
        options: {},
        memberRoleIds: [],
        userDisplayName: 'Ash Ketchum',
        ...over,
      },
      { ephemeral: async (text) => void sent.push(text) },
    );
    return sent;
  };
});
afterEach(() => w.close());

const link = (userId: string, playerId: string, userDisplayName = 'Someone') => route({ name: 'link', userId, options: { 'player-id': playerId }, userDisplayName });

describe('/link', () => {
  it('registers the one command with its required option', () => {
    expect(BOT_COMMANDS).toEqual([
      { name: 'link', description: expect.any(String), options: [{ name: 'player-id', description: expect.any(String), type: 'string', required: true }] },
    ]);
  });

  it('records a claim, moves it, refuses others and bad IDs, and never grants access', async () => {
    expect(await link(PEOPLE.ash, '7654321', 'Ash Ketchum')).toEqual(['Claim recorded. An organizer will confirm it on the Staff page.']);
    expect(w.directory.list()).toEqual([expect.objectContaining({ displayName: 'Ash Ketchum', linkState: 'claimed' })]);
    const organizerRow = w.directory.create({ displayName: 'Ash', playerId: '1112223' });
    expect(await link(PEOPLE.ash, '1112223')).toEqual(['Claim recorded. An organizer will confirm it on the Staff page.']);
    expect(w.directory.list().map((s) => s.playerId)).toEqual(['1112223']);
    expect(await link(PEOPLE.brock, '1112223')).toEqual(['That player ID is already taken. Ask an organizer.']);
    expect(await link(PEOPLE.brock, '12ab')).toEqual(["That isn't a player ID: use digits only."]);
    w.directory.create({ displayName: 'Misty', discordUserId: PEOPLE.misty });
    expect(await link(PEOPLE.misty, '9990001')).toEqual(["You're already linked as Misty."]);
    expect(w.directory.get(organizerRow.id)?.discordUserId).toBeNull();
  });

  it('allows five tries per user in ten minutes', async () => {
    for (let i = 0; i < 5; i++) await link(PEOPLE.gary, '12ab');
    expect(await link(PEOPLE.gary, '5550001')).toEqual(['Too many tries. Wait a few minutes.']);
    expect(w.directory.list()).toEqual([]);
    expect(await link(PEOPLE.brock, '5550002')).toEqual(['Claim recorded. An organizer will confirm it on the Staff page.']);
    w.clock.advance(10 * 60_000);
    expect(await link(PEOPLE.gary, '5550001')).toEqual(['Claim recorded. An organizer will confirm it on the Staff page.']);
  });
});

describe('the Sync button', () => {
  async function openDay() {
    const ash = w.directory.create({ displayName: 'Ash', discordUserId: PEOPLE.ash });
    const brock = w.directory.create({ displayName: 'Brock', discordUserId: PEOPLE.brock });
    const dawn = w.directory.create({ displayName: 'Dawn', discordUserId: PEOPLE.dawn });
    const { day } = w.days.createDay({ date: '2026-10-17', title: 'T' });
    const lc = w.days.addEvent(day.id, { name: 'LC', game: 'tcg', startTime: '10:00' });
    w.days.putStaff(day.id, [
      { staffMemberId: ash.id, events: [{ eventId: lc.id, role: 'headjudge' }] },
      { staffMemberId: brock.id, events: [{ eventId: lc.id, role: 'judge' }] },
      { staffMemberId: dawn.id, events: [] },
    ]);
    await w.provisioning.open(day.id);
    await w.jobs.runDue();
    return day;
  }
  const click = (dayId: number, userId: string, memberRoleIds: string[] = [], guildId: string = IDS.guild) =>
    route({ kind: 'component', name: `genie:day-sync:${dayId}`, userId, memberRoleIds, guildId });
  const queued = () => w.database.sqlite.prepare("SELECT id FROM job WHERE state = 'queued'").pluck().all();

  it('queues one sync for the organizer and a day head judge', async () => {
    const day = await openDay();
    expect(await click(day.id, PEOPLE.organizer, [IDS.organizerRole])).toEqual(['Sync queued.']);
    expect(await click(day.id, PEOPLE.ash)).toEqual(['Sync queued.']);
    expect(queued()).toHaveLength(1);
    expect(await click(day.id, PEOPLE.dawn, [IDS.headJudgeRole])).toEqual(['Sync queued.']);
  });

  it('refuses a plain judge, and drops a click from another guild', async () => {
    const day = await openDay();
    expect(await click(day.id, PEOPLE.brock)).toEqual(["Only this day's head judges and organizers can sync."]);
    expect(await click(day.id, PEOPLE.dawn)).toEqual(["Only this day's head judges and organizers can sync."]);
    expect(await click(day.id, PEOPLE.organizer, [IDS.organizerRole], '400000000000000009')).toEqual([]);
    expect(queued()).toEqual([]);
  });

  it('answers a closed or unknown day without revealing it to others', async () => {
    const draft = w.days.createDay({ date: '2026-10-17', title: 'Draft' }).day;
    expect(await click(draft.id, PEOPLE.organizer, [IDS.organizerRole])).toEqual(["This day isn't open."]);
    expect(await click(9999, PEOPLE.organizer, [IDS.organizerRole])).toEqual(["This day isn't open."]);
    expect(await click(9999, PEOPLE.brock)).toEqual(["Only this day's head judges and organizers can sync."]);
    expect(await route({ kind: 'component', name: 'genie:something-else' })).toEqual(["This button isn't available."]);
  });
});
