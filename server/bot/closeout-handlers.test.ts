import { afterEach, describe, expect, it } from 'vitest';
import { type CloseoutWorld, closeoutWorld } from '../../test/support/closeout-world';
import { BOT_TOKEN, IDS } from '../../test/support/discord-world';
import { recordingLogger } from '../../test/support/logger';
import { PEOPLE } from '../../test/support/provisioning-world';
import type { InboundInteraction } from '../modules/discord/port';
import { createCloseoutHandlers } from './closeout-handlers';
import { createInteractionRouter } from './router';

let w: CloseoutWorld;
let logger: ReturnType<typeof recordingLogger>;
let ids = 710_000_000_000_000_000n;
afterEach(async () => w?.dispose());

async function world() {
  w = await closeoutWorld();
  logger = recordingLogger();
  const handlers = createCloseoutHandlers({
    closeout: w.closeout,
    provisioning: w.provisioning,
    eventDays: w.days,
    access: () => ({ ownerId: IDS.owner, organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole, allowlist: { enabled: false, userIds: [] } }),
    logger,
  });
  const router = createInteractionRouter({ boundGuildId: () => IDS.guild, logger, commands: {}, components: handlers.components });
  await w.discord.create(BOT_TOKEN).bot.connect({ onInteraction: (i, reply) => router.route(i, reply) });
}

const click = (customId: string, userId: string, guildId: string | null = IDS.guild) =>
  w.discord.interact({
    id: String(++ids),
    kind: 'component',
    name: customId,
    guildId,
    channelId: w.channel('head-judges').id,
    userId,
    options: {},
    memberRoleIds: userId === PEOPLE.organizer ? [IDS.organizerRole] : [],
    userDisplayName: 'Someone',
  } satisfies InboundInteraction);

describe('closing from the #head-judges panel', () => {
  it('asks a day head judge to confirm with the counts, then closes', async () => {
    await world();
    await w.penalties.record(w.recordInput());
    const asked = await click(`genie:day-close:${w.dayId}`, PEOPLE.brock);
    expect(asked.ephemeral).toEqual([
      'Close Saturday? Its 6 channels will be locked and exported. 1 penalty may still be edited by its judge. 1 event has no Tournament ID, so its CSV waits for one.',
    ]);
    expect(asked.buttons).toEqual([{ customId: `genie:day-close-confirm:${w.dayId}`, label: 'Confirm close', style: 'danger' }]);
    expect(w.days.plan(w.dayId).day.state).toBe('open');

    expect((await click(`genie:day-close-confirm:${w.dayId}`, PEOPLE.brock)).ephemeral).toEqual(['Closing the day: the channels are being locked.']);
    expect(w.days.plan(w.dayId).day).toMatchObject({ state: 'closing', closedBy: PEOPLE.brock });
    expect((await click(`genie:day-close:${w.dayId}`, PEOPLE.organizer)).ephemeral).toEqual(["This day isn't open."]);
    expect((await click(`genie:day-close-confirm:${w.dayId}`, PEOPLE.organizer)).ephemeral).toEqual(["This day isn't open."]);
  });

  it('refuses a staffer who isn’t a day head judge, and an unknown day, without revealing either', async () => {
    await world();
    const text = "Only this day's head judges and organizers can close it.";
    expect((await click(`genie:day-close:${w.dayId}`, PEOPLE.ash)).ephemeral).toEqual([text]);
    expect((await click(`genie:day-close-confirm:${w.dayId}`, PEOPLE.ash)).ephemeral).toEqual([text]);
    expect((await click('genie:day-close:999', PEOPLE.brock)).ephemeral).toEqual([text]);
    expect((await click('genie:day-close-confirm:nope', PEOPLE.brock)).ephemeral).toEqual([text]);
    expect(w.days.plan(w.dayId).day.state).toBe('open');
  });

  it('passes on a refusal the close gives, and drops a click from another guild', async () => {
    await world();
    w.discord.unavailable = true;
    expect((await click(`genie:day-close-confirm:${w.dayId}`, PEOPLE.organizer)).ephemeral).toEqual(['Discord could not be reached. Try again in a moment.']);
    w.discord.unavailable = false;
    expect((await click(`genie:day-close-confirm:${w.dayId}`, PEOPLE.organizer, IDS.otherGuild)).ephemeral).toEqual([]);
    expect(logger.records.some((r) => /dropped/i.test(r.msg))).toBe(true);
    expect(w.days.plan(w.dayId).day.state).toBe('open');
  });
});
