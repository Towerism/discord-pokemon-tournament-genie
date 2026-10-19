import { createRedactor, silentLogger } from '@towerism/selfhost-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { member } from '../../../shared/discord/overwrites';
import { PERMISSION_BITS as P } from '../../../shared/discord/permissions';
import { ALL_PERMISSIONS, BOT_TOKEN, IDS } from '../../../test/support/discord-world';
import { PEOPLE, type ProvisioningWorld, provisioningWorld } from '../../../test/support/provisioning-world';
import { ServiceError } from '../errors';
import { createJobs } from '../jobs/jobs';
import { createSqliteJobStore } from '../jobs/sqlite-store';
import { createProvisioningService, overwritesHash } from './index';

let w: ProvisioningWorld;
afterEach(() => w.close());

const CHANNELS = ['day-staff', 'head-judges', 'lc-floor', 'lc-penalties', 'vgc-floor', 'vgc-penalties'];
const sorted = (...ids: string[]) => [...ids].sort();

/** The October LC day on the fake: LC (Ash head judge, Brock judge), VGC (Misty judge), Dawn on the day with the head-judge role. */
function octoberDay() {
  const ash = w.directory.create({ displayName: 'Ash', discordUserId: PEOPLE.ash });
  const brock = w.directory.create({ displayName: 'Brock', discordUserId: PEOPLE.brock });
  const misty = w.directory.create({ displayName: 'Misty', discordUserId: PEOPLE.misty });
  const dawn = w.directory.create({ displayName: 'Dawn', discordUserId: PEOPLE.dawn });
  w.discord.guilds.get(IDS.guild)!.members.set(PEOPLE.dawn, [IDS.headJudgeRole]);
  const { day } = w.days.createDay({ date: '2026-10-17', title: 'October LC' });
  const lc = w.days.addEvent(day.id, { name: 'LC', game: 'tcg', startTime: '10:00' });
  const vgc = w.days.addEvent(day.id, { name: 'VGC', game: 'vgc', startTime: '11:30' });
  const staff = (extra: { staffMemberId: number; events: { eventId: number; role: 'headjudge' | 'judge' }[] }[] = []) => [
    { staffMemberId: ash.id, events: [{ eventId: lc.id, role: 'headjudge' as const }] },
    { staffMemberId: brock.id, events: [{ eventId: lc.id, role: 'judge' as const }] },
    { staffMemberId: misty.id, events: [{ eventId: vgc.id, role: 'judge' as const }] },
    { staffMemberId: dawn.id, events: [] },
    ...extra,
  ];
  w.days.putStaff(day.id, staff());
  return { day, lc, vgc, ash, brock, misty, dawn, staff };
}

async function openAndRun(dayId: number) {
  const { jobId } = await w.provisioning.open(dayId);
  await w.jobs.runDue();
  return w.jobs.get(jobId)!;
}
const sync = async (dayId: number) => {
  const { jobId } = w.provisioning.sync(dayId);
  await w.jobs.runDue();
  return w.jobs.get(jobId)!;
};
const messages = (jobId: number) => w.jobs.events(jobId).map((e) => e.message);

describe('after the day is closed', () => {
  beforeEach(() => {
    w = provisioningWorld();
  });

  it('posts a panel with Sync and Close the day', async () => {
    const { day } = octoberDay();
    await openAndRun(day.id);
    const panel = [...w.discord.messages.values()].find((m) => m.channelId === w.channel('head-judges').id)!;
    expect(panel.buttons.map((b) => [b.label, b.customId])).toEqual([
      ['Sync', `genie:day-sync:${day.id}`],
      ['Close the day', `genie:day-close:${day.id}`],
    ]);
  });

  it('runs a sync queued before the close without touching Discord', async () => {
    const { day, staff } = octoberDay();
    await openAndRun(day.id);
    w.days.putStaff(day.id, staff().slice(1));
    const before = w.discord.restCalls;
    w.days.markClosing(day.id, PEOPLE.ash, () => 0);
    await w.jobs.runDue();
    const job = w.jobs.latestOf(day.id, ['sync'])!;
    expect(job.state).toBe('succeeded');
    expect(messages(job.id)).toContain('The day isn’t open: nothing to sync.');
    expect(w.discord.restCalls).toBe(before);
  });

  it('refuses to adopt an orphan once the day is closing', async () => {
    const { day } = octoberDay();
    await openAndRun(day.id);
    w.days.markClosing(day.id, PEOPLE.ash, () => 0);
    expect(() => w.provisioning.adoptOrphan(day.id, '123456789012345678', { key: 'day-staff', eventId: null })).toThrow(
      expect.objectContaining({ code: 'day_closed' }) as Error,
    );
  });

  it('gives the lock each present channel with the locked set of what the frozen plan wants, and the panel', async () => {
    const { day, staff } = octoberDay();
    await openAndRun(day.id);
    const targets = await w.provisioning.lockTargets(day.id);
    expect(targets.channels.map((c) => c.name).sort()).toEqual(CHANNELS);
    const floor = targets.channels.find((c) => c.name === 'lc-floor')!;
    expect(floor.discordChannelId).toBe(w.channel('lc-floor').id);
    expect(floor.locked.find((o) => o.target.kind === 'member' && o.target.id === PEOPLE.brock)).toEqual(
      member(PEOPLE.brock, { allow: P.ViewChannel | P.ReadMessageHistory | P.AttachFiles, deny: P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads | P.AddReactions }),
    );
    expect(targets.panel).toEqual({ channelId: w.channel('head-judges').id, messageId: expect.any(String) as string });

    // The plan is what counts: a channel whose audience emptied keeps only the bot's member overwrite.
    w.days.putStaff(day.id, staff().filter((s) => s.staffMemberId !== staff()[2]!.staffMemberId));
    const later = await w.provisioning.lockTargets(day.id);
    expect(later.channels.find((c) => c.name === 'vgc-floor')!.locked.filter((o) => o.target.kind === 'member').map((o) => o.target)).toEqual([
      { kind: 'member', id: w.discord.applications.get(IDS.app)!.botUserId },
    ]);
  });

  it('records the lock, a missing channel and a deleted one on its rows', async () => {
    const { day } = octoberDay();
    await openAndRun(day.id);
    const [first, second, third] = (await w.provisioning.lockTargets(day.id)).channels;
    w.provisioning.markChannel(first!.rowId, 'locked');
    w.provisioning.markChannel(second!.rowId, 'missing');
    w.provisioning.markChannel(third!.rowId, 'deleted');
    const rows = w.provisioning.closeoutChannels(day.id);
    expect(rows.find((r) => r.rowId === first!.rowId)).toMatchObject({ state: 'present', lockedAt: w.clock.now() });
    expect(rows.find((r) => r.rowId === second!.rowId)).toMatchObject({ state: 'missing' });
    expect(rows.find((r) => r.rowId === third!.rowId)).toMatchObject({ state: 'deleted' });
  });
});

describe('opening a day', () => {
  beforeEach(() => {
    w = provisioningWorld();
  });

  it('creates the category and channels that only their audiences, admins and organizers can see', async () => {
    const { day } = octoberDay();
    const job = await openAndRun(day.id);
    expect(job.state).toBe('succeeded');

    const category = w.channel('🏆 Sat Oct 17 · October LC');
    expect(w.discord.channelsOf(IDS.guild, category.id).map((c) => c.name)).toEqual(CHANNELS);
    expect(w.staffViewers('day-staff')).toEqual(sorted(PEOPLE.ash, PEOPLE.brock, PEOPLE.misty, PEOPLE.dawn));
    expect(w.staffViewers('head-judges')).toEqual(sorted(PEOPLE.ash, PEOPLE.dawn));
    expect(w.staffViewers('lc-floor')).toEqual(sorted(PEOPLE.ash, PEOPLE.brock));
    expect(w.staffViewers('lc-penalties')).toEqual(sorted(PEOPLE.ash, PEOPLE.brock));
    expect(w.staffViewers('vgc-floor')).toEqual([PEOPLE.misty]);
    expect(w.staffViewers(category.name)).toEqual([]);
    for (const name of CHANNELS) {
      expect(w.viewers(name)).toContain(PEOPLE.admin);
      expect(w.viewers(name)).toContain(PEOPLE.organizer);
      expect(w.viewers(name)).not.toContain(PEOPLE.outsider);
    }
    expect(w.provisioning.channels(day.id).filter((c) => c.state === 'present')).toHaveLength(6);
    const intro = [...w.discord.messages.values()].find((m) => m.channelId === w.channel('day-staff').id)!;
    expect(intro.pinned).toBe(true);
    const panel = [...w.discord.messages.values()].find((m) => m.channelId === w.channel('head-judges').id)!;
    expect(panel.buttons).toEqual([
      { customId: `genie:day-sync:${day.id}`, label: 'Sync' },
      { customId: `genie:day-close:${day.id}`, label: 'Close the day' },
    ]);
    expect(messages(job.id)).toContain('also visible to: 2 administrators, 1 organizers');
    expect(w.days.plan(day.id).sync).toMatchObject({ inSync: true, revocationPending: false });
  });

  it('refuses unready days, changing nothing', async () => {
    const { day } = octoberDay();
    w.directory.claim({ userId: PEOPLE.gary, playerId: '5550001', displayName: 'Gary' });
    const gary = w.directory.list().find((s) => s.displayName === 'Gary')!;
    w.days.putStaff(day.id, [...w.days.plan(day.id).staff.map((s) => ({ staffMemberId: s.staffMemberId, events: s.events })), { staffMemberId: gary.id, events: [] }]);
    await expect(w.provisioning.open(day.id)).rejects.toMatchObject({ status: 422, code: 'open_preconditions_failed', data: { problems: [{ code: 'unlinked_staff', staffMemberIds: [gary.id] }] } });
    expect(w.days.plan(day.id).day.state).toBe('draft');
    expect(w.jobs.events(1)).toEqual([]);
  });

  it('names a missing permission and a full guild', async () => {
    w.close();
    w = provisioningWorld({ botPermissions: ALL_PERMISSIONS & ~P.CreatePrivateThreads });
    const { day } = octoberDay();
    await expect(w.provisioning.open(day.id)).rejects.toMatchObject({ data: { problems: [{ code: 'missing_permissions', permissions: ['CreatePrivateThreads'] }] } });
    w.close();
    w = provisioningWorld();
    const second = octoberDay();
    const filler = await w.discord.create('fake-bot-token-0123456789').gateway.createCategory(IDS.guild, { name: 'filler', overwrites: [] });
    for (let i = 0; i < 493; i++) w.discord.channels.set(`f${i}`, { id: `f${i}`, guildId: IDS.guild, type: 'text', name: `f${i}`, parentId: filler, topic: null, position: i, overwrites: [] });
    await expect(w.provisioning.open(second.day.id)).rejects.toMatchObject({ data: { problems: [{ code: 'channel_limit', needed: 7, available: 6 }] } });
  });

  it('opens a day for a bot invited before Pin Messages was in the invite', async () => {
    w.close();
    w = provisioningWorld({ botPermissions: ALL_PERMISSIONS & ~P.PinMessages });
    const { day } = octoberDay();
    const { jobId } = await w.provisioning.open(day.id);
    expect(w.days.plan(day.id).day.state).toBe('open');
    expect(w.jobs.get(jobId)!.state).toBe('queued');
  });

  it('refuses to open a day twice', async () => {
    const { day } = octoberDay();
    await openAndRun(day.id);
    await expect(w.provisioning.open(day.id)).rejects.toMatchObject({ status: 409, code: 'day_not_draft' });
  });

  it('answers 503 when Discord is down, leaving the day a draft', async () => {
    const { day } = octoberDay();
    w.discord.unavailable = true;
    await expect(w.provisioning.open(day.id)).rejects.toMatchObject({ status: 503, code: 'discord_unavailable' });
    expect(w.days.plan(day.id).day.state).toBe('draft');
  });
});

describe('syncing', () => {
  beforeEach(() => {
    w = provisioningWorld();
  });

  it('makes no mutating call when nothing changed, and only the needed ones for an addition', async () => {
    const { day, vgc, staff } = octoberDay();
    await openAndRun(day.id);
    const calls = w.discord.mutations.length;
    expect((await sync(day.id)).state).toBe('succeeded');
    expect(w.discord.mutations.length).toBe(calls);

    const gary = w.directory.create({ displayName: 'Gary', discordUserId: PEOPLE.gary });
    w.days.putStaff(day.id, staff([{ staffMemberId: gary.id, events: [{ eventId: vgc.id, role: 'judge' }] }]));
    await sync(day.id);
    const changed = w.discord.mutations.slice(calls).map((m) => [m.method, w.discord.channels.get(m.target)?.name]);
    expect(changed.sort()).toEqual([
      ['setOverwrites', 'day-staff'],
      ['setOverwrites', 'vgc-floor'],
      ['setOverwrites', 'vgc-penalties'],
    ]);
    expect(CHANNELS.filter((n) => w.viewers(n).includes(PEOPLE.gary))).toEqual(['day-staff', 'vgc-floor', 'vgc-penalties']);

    w.days.patchDay(day.id, { title: 'Renamed' });
    const before = w.discord.mutations.length;
    await sync(day.id);
    expect(w.discord.mutations.slice(before).map((m) => m.method)).toEqual(['updateChannel']);
    expect(w.channel('🏆 Sat Oct 17 · Renamed').type).toBe('category');
  });

  it('revokes a removed staffer at once and clears the alarm', async () => {
    const { day, staff } = octoberDay();
    await openAndRun(day.id);
    const { syncJobId } = w.days.putStaff(day.id, staff().filter((s) => s.staffMemberId !== staff()[1]!.staffMemberId));
    expect(w.provisioning.alarms()).toHaveLength(1);
    await w.jobs.runDue();
    expect(w.jobs.get(syncJobId!)!.state).toBe('succeeded');
    for (const name of CHANNELS) expect(w.viewers(name)).not.toContain(PEOPLE.brock);
    expect(w.provisioning.alarms()).toEqual([]);
  });

  it('takes #head-judges away from a demoted head judge', async () => {
    const { day, lc, staff } = octoberDay();
    await openAndRun(day.id);
    w.days.putStaff(day.id, staff().map((s, i) => (i === 0 ? { ...s, events: [{ eventId: lc.id, role: 'judge' as const }] } : s)));
    await w.jobs.runDue();
    expect(w.viewers('head-judges')).not.toContain(PEOPLE.ash);
    expect(w.viewers('lc-floor')).toContain(PEOPLE.ash);
  });

  it('revokes a relinked staffer’s old account and admits the new one', async () => {
    const { day, misty } = octoberDay();
    await openAndRun(day.id);
    w.directory.update(misty.id, { discordUserId: PEOPLE.gary });
    await w.jobs.runDue();
    for (const name of CHANNELS) expect(w.viewers(name)).not.toContain(PEOPLE.misty);
    expect(w.viewers('vgc-floor')).toContain(PEOPLE.gary);
  });

  it('corrects drift: a deleted channel, an outsider added by hand, and a foreign channel', async () => {
    const { day } = octoberDay();
    await openAndRun(day.id);
    const gateway = w.discord.create('fake-bot-token-0123456789').gateway;
    const lcFloor = w.channel('lc-floor').id;
    w.discord.channels.delete(lcFloor);
    const penalties = w.channel('lc-penalties');
    w.discord.forceOverwrites(penalties.id, [...penalties.overwrites, member(PEOPLE.outsider, { allow: P.ViewChannel })]);
    const category = w.days.plan(day.id).day.categoryId!;
    const random = await gateway.createChannel(IDS.guild, { name: 'random', parentId: category, overwrites: [] });

    expect((await sync(day.id)).state).toBe('succeeded');
    const rows = w.provisioning.channels(day.id);
    expect(rows.find((r) => r.discordChannelId === lcFloor)?.state).toBe('missing');
    expect(w.staffViewers('lc-floor')).toEqual(sorted(PEOPLE.ash, PEOPLE.brock));
    expect(w.viewers('lc-penalties')).not.toContain(PEOPLE.outsider);
    expect(w.provisioning.orphans(day.id)).toEqual([expect.objectContaining({ discordChannelId: random, kind: 'channel', name: 'random' })]);
  });

  it('recreates a deleted category and moves the channels back under it, creating none', async () => {
    const { day } = octoberDay();
    await openAndRun(day.id);
    const ids = CHANNELS.map((n) => w.channel(n).id);
    w.discord.channels.delete(w.days.plan(day.id).day.categoryId!);
    for (const id of ids) w.discord.channels.get(id)!.parentId = null;

    const before = w.discord.mutations.length;
    expect((await sync(day.id)).state).toBe('succeeded');
    const category = w.days.plan(day.id).day.categoryId!;
    expect(ids.map((id) => w.discord.channels.get(id)!.parentId)).toEqual(ids.map(() => category));
    expect(w.discord.mutations.slice(before).filter((m) => m.method === 'createChannel')).toEqual([]);
    expect(w.staffViewers('lc-floor')).toEqual(sorted(PEOPLE.ash, PEOPLE.brock));
  });

  it('fails before any write when the bot lacks Manage Roles', async () => {
    const { day, staff } = octoberDay();
    await openAndRun(day.id);
    const botRole = w.discord.guilds.get(IDS.guild)!.roles.find((r) => r.managed)!;
    botRole.permissions &= ~P.ManageRoles;
    const { syncJobId } = w.days.putStaff(day.id, staff().slice(1));
    const before = w.discord.mutations.length;
    await w.jobs.runDue();
    expect(w.jobs.get(syncJobId!)).toMatchObject({ state: 'failed', error: 'missing_permissions: ManageRoles' });
    expect(w.discord.mutations.length).toBe(before);
    expect(w.provisioning.alarms()).toHaveLength(1);
  });

  it('fails with the refused call when Manage Roles goes between the check and the first write', async () => {
    const { day, vgc, staff } = octoberDay();
    await openAndRun(day.id);
    const gary = w.directory.create({ displayName: 'Gary', discordUserId: PEOPLE.gary });
    w.days.putStaff(day.id, staff([{ staffMemberId: gary.id, events: [{ eventId: vgc.id, role: 'judge' }] }]));
    // The fake checks a call against its state when the call reaches it: the role loses Manage Roles right then.
    w.discord.failOn((call) => {
      if (call.method === 'setOverwrites') w.discord.guilds.get(IDS.guild)!.roles.find((r) => r.managed)!.permissions &= ~P.ManageRoles;
      return null;
    });
    const job = await sync(day.id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/setOverwrites/);
  });

  it('keeps a removal landing when an unrelated permission is gone, with a warning', async () => {
    const { day, staff } = octoberDay();
    await openAndRun(day.id);
    w.discord.guilds.get(IDS.guild)!.roles.find((r) => r.managed)!.permissions &= ~P.EmbedLinks;
    const { syncJobId } = w.days.putStaff(day.id, staff().slice(0, 1).concat(staff().slice(2)));
    await w.jobs.runDue();
    expect(w.jobs.get(syncJobId!)!.state).toBe('succeeded');
    expect(w.jobs.events(syncJobId!).some((e) => e.level === 'warn' && e.message.includes('EmbedLinks'))).toBe(true);
    for (const name of CHANNELS) expect(w.viewers(name)).not.toContain(PEOPLE.brock);
    expect(w.provisioning.alarms()).toEqual([]);
  });

  it('fails the audit loudly when Discord ignores an overwrite', async () => {
    const { day } = octoberDay();
    await openAndRun(day.id);
    const floor = w.channel('lc-floor');
    w.discord.forceOverwrites(floor.id, [...floor.overwrites, member(PEOPLE.outsider, { allow: P.ViewChannel })]);
    // Discord accepts the correction but doesn't apply it: only the audit can tell.
    const original = w.discord.create;
    w.discord.create = (token) => {
      const port = original(token);
      return { ...port, gateway: { ...port.gateway, setOverwrites: async (id, o) => (id === floor.id ? undefined : port.gateway.setOverwrites(id, o)) } };
    };
    const job = await sync(day.id);
    expect(job.state).toBe('failed');
    expect(job.error).toBe('privacy_audit_failed');
    const failure = w.jobs.events(job.id).find((e) => e.level === 'error' && e.message.startsWith('privacy audit'))!;
    expect(failure.data).toMatchObject({ failures: [{ key: 'floor', name: 'lc-floor', extra: [PEOPLE.outsider], missing: [] }] });
  });

  it('refuses to sync a draft day, and coalesces queued syncs', async () => {
    const { day } = octoberDay();
    expect(() => w.provisioning.sync(day.id)).toThrow(ServiceError);
    await openAndRun(day.id);
    const first = w.provisioning.sync(day.id);
    expect(w.provisioning.sync(day.id)).toEqual({ jobId: first.jobId, coalesced: true });
  });
});

describe('crash safety', () => {
  beforeEach(() => {
    w = provisioningWorld();
  });

  it('ends with exactly one channel per desired channel after a failure at any call', async () => {
    // Count the provision's mutating calls once, then fail each of them in turn, in both ways.
    const probe = provisioningWorld();
    const swap = w;
    w = probe;
    const { day: probeDay } = octoberDay();
    await openAndRun(probeDay.id);
    const total = probe.discord.mutations.length;
    probe.close();
    w = swap;

    for (const mode of ['unavailable', 'lost_answer'] as const) {
      for (let k = 0; k < total; k++) {
        w.close();
        w = provisioningWorld();
        const { day } = octoberDay();
        // Fail the k-th mutating call of this provision, and no other.
        w.discord.failOn((_call, index) => (index === k ? mode : null));
        const first = await openAndRun(day.id);
        w.discord.failOn(null);
        if (first.state === 'failed') await sync(day.id);
        const category = w.days.plan(day.id).day.categoryId!;
        const names = w.discord.channelsOf(IDS.guild, category).map((c) => c.name);
        const recorded = new Set(w.provisioning.channels(day.id).filter((c) => c.state === 'present').map((c) => c.discordChannelId));
        expect(recorded.size, `${mode} at call ${k}`).toBe(6);
        for (const n of CHANNELS) expect(w.discord.channelsOf(IDS.guild, category).filter((c) => c.name === n && recorded.has(c.id)), `${mode} at ${k}: ${n}`).toHaveLength(1);
        const orphans = w.provisioning.orphans(day.id);
        expect(orphans.length, `${mode} at ${k}`).toBeLessThanOrEqual(1);
        if (mode === 'unavailable') expect(names.length, `${mode} at ${k}`).toBe(6);
        // An orphan left by a lost answer never carries staff.
        for (const o of orphans) {
          for (const person of [PEOPLE.ash, PEOPLE.brock, PEOPLE.misty, PEOPLE.dawn]) {
            expect(w.discord.permissionsFor(person, o.discordChannelId) & P.ViewChannel, `${mode} at ${k}: orphan`).toBe(0n);
          }
        }
      }
    }
  });

  it('removes a staffer from both copies after a lost-answer create', async () => {
    const { day, staff, brock } = octoberDay();
    // The first create of lc-penalties is applied, but its answer is lost.
    let lost = false;
    w.discord.failOn((call) => {
      if (lost || call.method !== 'createChannel' || call.target !== 'lc-penalties') return null;
      lost = true;
      return 'lost_answer';
    });
    const first = await openAndRun(day.id);
    expect(first.state).toBe('failed');
    await sync(day.id);
    const copies = w.discord.channelsOf(IDS.guild).filter((c) => c.name === 'lc-penalties');
    expect(copies).toHaveLength(2);
    w.days.putStaff(day.id, staff().filter((s) => s.staffMemberId !== brock.id));
    await w.jobs.runDue();
    for (const c of copies) expect(w.discord.permissionsFor(PEOPLE.brock, c.id) & P.ViewChannel).toBe(0n);
    expect(w.provisioning.alarms()).toEqual([]);
  });

  it('lists a stray category left by a lost category create', async () => {
    const { day } = octoberDay();
    w.discord.failNext('lost_answer');
    expect((await openAndRun(day.id)).state).toBe('failed');
    expect((await sync(day.id)).state).toBe('succeeded');
    expect(w.provisioning.orphans(day.id)).toEqual([expect.objectContaining({ kind: 'category', name: '🏆 Sat Oct 17 · October LC' })]);
  });
});

describe('removals racing a sync', () => {
  beforeEach(() => {
    w = provisioningWorld();
  });

  it('keeps the alarm through a sync that read the plan before a removal, and clears it with the next', async () => {
    const { day, vgc, staff, brock } = octoberDay();
    await openAndRun(day.id);
    const gary = w.directory.create({ displayName: 'Gary', discordUserId: PEOPLE.gary });
    const withGary = staff([{ staffMemberId: gary.id, events: [{ eventId: vgc.id, role: 'judge' }] }]);
    w.days.putStaff(day.id, withGary);
    const first = w.provisioning.sync(day.id);
    // The removal lands at the running sync's first write: it has already read the plan without it.
    let second: number | null = null;
    w.discord.failOn(() => {
      if (second === null) second = w.days.putStaff(day.id, withGary.filter((s) => s.staffMemberId !== brock.id)).syncJobId;
      return null;
    });
    await w.jobs.runDue();
    w.discord.failOn(null);
    expect(w.jobs.get(first.jobId)!.state).toBe('succeeded');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first.jobId);
    expect(w.provisioning.alarms()).toEqual([expect.objectContaining({ dayId: day.id })]);
    await w.jobs.runDue();
    expect(w.jobs.get(second!)!.state).toBe('succeeded');
    expect(w.provisioning.alarms()).toEqual([]);
    for (const name of CHANNELS) expect(w.viewers(name)).not.toContain(PEOPLE.brock);
  });

  it('records the full overwrites’ hash on a recreated channel’s new row', async () => {
    const { day } = octoberDay();
    await openAndRun(day.id);
    w.discord.channels.delete(w.channel('lc-floor').id);
    await sync(day.id);
    const floor = w.channel('lc-floor');
    const row = w.database.sqlite
      .prepare("SELECT applied_overwrites_hash AS hash FROM provisioned_channel WHERE discord_channel_id = ? AND state = 'present'")
      .get(floor.id) as { hash: string };
    // The new row carries the hash of what Discord now holds (its audience), not the base overwrites it was created with.
    expect(row.hash).toBe(overwritesHash(floor.overwrites));
  });

  const intro = () => [...w.discord.messages.values()].filter((m) => m.channelId === w.channel('day-staff').id);
  const warnings = (jobId: number) => w.jobs.events(jobId).filter((e) => e.level === 'warn').map((e) => e.message);
  const PIN_REFUSED = "Couldn't pin the intro: the bot needs the Pin Messages permission. Add it to Genie's role; the next sync pins it.";

  it('warns, never fails, when the intro can’t be pinned, and pins it on the next sync', async () => {
    const { day } = octoberDay();
    w.discord.failOn((call) => (call.method === 'pinMessage' ? 'unavailable' : null));
    const job = await openAndRun(day.id);
    w.discord.failOn(null);
    expect(job.state).toBe('succeeded');
    expect(warnings(job.id)).toContain("Couldn't pin the intro; the next sync tries again.");
    expect(w.days.plan(day.id).sync.inSync).toBe(true);
    await sync(day.id);
    expect(intro()[0]!.pinned).toBe(true);
    expect(intro()).toHaveLength(1);
  });

  it('says to add Pin Messages when the bot lacks it, then pins the same intro once it has it', async () => {
    w.close();
    w = provisioningWorld({ botPermissions: ALL_PERMISSIONS & ~P.PinMessages });
    const { day } = octoberDay();
    const job = await openAndRun(day.id);
    expect(job.state).toBe('succeeded');
    expect(w.days.plan(day.id).sync.inSync).toBe(true);
    expect(intro()).toHaveLength(1);
    expect(intro()[0]!.pinned).toBe(false);
    expect(warnings(job.id)).toContain(PIN_REFUSED);

    w.discord.guilds.get(IDS.guild)!.roles.find((r) => r.managed)!.permissions |= P.PinMessages;
    const fixed = await sync(day.id);
    expect(intro()).toHaveLength(1);
    expect(intro()[0]!.pinned).toBe(true);
    expect(warnings(fixed.id)).toEqual([]);
    const later = await sync(day.id);
    expect(warnings(later.id)).toEqual([]);
  });

  it('names the intro or the panel when posting it fails, and never fails the sync', async () => {
    const { day } = octoberDay();
    const named = (name: string) => (call: { method: string; target: string }) => (call.method === 'postMessage' && w.discord.channels.get(call.target)?.name === name ? 'unavailable' : null);
    w.discord.failOn(named('day-staff'));
    const job = await openAndRun(day.id);
    w.discord.failOn(null);
    expect(job.state).toBe('succeeded');
    expect(warnings(job.id)).toContain("Couldn't post the intro; the next sync tries again.");
    expect(intro()).toEqual([]);
    await sync(day.id);
    expect(intro()).toHaveLength(1);

    w.close();
    w = provisioningWorld();
    const other = octoberDay();
    w.discord.failOn(named('head-judges'));
    const panelJob = await openAndRun(other.day.id);
    w.discord.failOn(null);
    expect(panelJob.state).toBe('succeeded');
    expect(warnings(panelJob.id)).toEqual(["Couldn't post the panel; the next sync tries again."]);
  });
});

describe('boot recovery', () => {
  beforeEach(() => {
    w = provisioningWorld();
  });

  it('retries a removal sync the process stopped in the middle of, on a fresh jobs instance', async () => {
    const { day, staff } = octoberDay();
    await openAndRun(day.id);
    // The process "stops" while the removal sync is held mid-run: it stays `running` in the database.
    w.discord.writeGate = new Promise(() => {});
    const { syncJobId } = w.days.putStaff(day.id, staff().slice(1));
    void w.jobs.runDue();
    await expect.poll(() => w.jobs.get(syncJobId!)!.state).toBe('running');
    w.discord.writeGate = null;

    const jobs = createJobs({ store: createSqliteJobStore(w.database.db), clock: w.clock, logger: silentLogger, redactor: createRedactor({ extraKeys: [] }) });
    const provisioning = createProvisioningService({
      db: w.database.db,
      clock: w.clock,
      logger: silentLogger,
      eventDays: w.days,
      jobs,
      gateway: () => w.discord.create(BOT_TOKEN).gateway,
      binding: () => ({ guildId: IDS.guild, organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole }),
    });
    provisioning.register();
    jobs.recover();
    provisioning.recoverOnBoot();
    expect(jobs.get(syncJobId!)!.state).toBe('queued');
    expect(provisioning.alarms()).toEqual([expect.objectContaining({ dayId: day.id, since: w.clock.now() })]);
    await jobs.runDue();
    expect(jobs.get(syncJobId!)!.state).toBe('succeeded');
    expect(provisioning.alarms()).toEqual([]);
    for (const name of CHANNELS) expect(w.viewers(name)).not.toContain(PEOPLE.ash);
  });

  it('queues a sync at boot for a day whose removal never landed, which then clears the alarm', async () => {
    const { day, staff } = octoberDay();
    await openAndRun(day.id);
    w.discord.unavailable = true;
    w.days.putStaff(day.id, staff().slice(1));
    await w.jobs.runDue();
    expect(w.provisioning.alarms()).toEqual([expect.objectContaining({ dayId: day.id })]);

    w.discord.unavailable = false;
    w.jobs.recover();
    w.provisioning.recoverOnBoot();
    await w.jobs.runDue();
    expect(w.provisioning.alarms()).toEqual([]);
    for (const name of CHANNELS) expect(w.viewers(name)).not.toContain(PEOPLE.ash);
  });
});
