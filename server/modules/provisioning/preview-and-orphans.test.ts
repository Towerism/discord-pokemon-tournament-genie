import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BLUEPRINT } from '../../../shared/blueprints';
import { PERMISSION_BITS as P } from '../../../shared/discord/permissions';
import { BOT_TOKEN, IDS } from '../../../test/support/discord-world';
import { ADMIN_ROLE, PEOPLE, type ProvisioningWorld, provisioningWorld } from '../../../test/support/provisioning-world';

let w: ProvisioningWorld;
afterEach(() => w.close());

function seedDay() {
  const ash = w.directory.create({ displayName: 'Ash', discordUserId: PEOPLE.ash });
  const brock = w.directory.create({ displayName: 'Brock', discordUserId: PEOPLE.brock });
  const misty = w.directory.create({ displayName: 'Misty', discordUserId: PEOPLE.misty });
  const { day } = w.days.createDay({ date: '2026-10-17', title: 'October LC' });
  const lc = w.days.addEvent(day.id, { name: 'LC', game: 'tcg', startTime: '10:00' });
  const vgc = w.days.addEvent(day.id, { name: 'VGC', game: 'vgc', startTime: '11:30' });
  w.days.putStaff(day.id, [
    { staffMemberId: ash.id, events: [{ eventId: lc.id, role: 'headjudge' }] },
    { staffMemberId: brock.id, events: [{ eventId: lc.id, role: 'judge' }] },
    { staffMemberId: misty.id, events: [{ eventId: vgc.id, role: 'judge' }] },
  ]);
  return { day, lc, vgc, ash };
}
const open = async (dayId: number) => {
  await w.provisioning.open(dayId);
  await w.jobs.runDue();
};
const hj = (userId: string, holdsHeadJudgeRole = false) => ({ userId, grant: 'event_head_judge' as const, holdsHeadJudgeRole });
const organizer = { userId: PEOPLE.organizer, grant: 'organizer_role' as const, holdsHeadJudgeRole: false };

describe('the preview', () => {
  it('shows the organizer every channel with audience names', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    const preview = await w.provisioning.preview(day.id, organizer);
    expect(preview.category.name).toBe('🏆 Sat Oct 17 · October LC');
    expect(preview.channels.map((c) => c.name)).toEqual(['day-staff', 'head-judges', 'lc-floor', 'lc-penalties', 'vgc-floor', 'vgc-penalties']);
    expect(preview.channels.find((c) => c.name === 'lc-floor')!.audience.map((a) => a.displayName)).toEqual(['Ash', 'Brock']);
    expect(preview).toMatchObject({ alsoVisibleTo: ['organizer_role', 'bot'], problems: [], headJudgeRole: 'checked' });
  });

  it('shows a head judge only what Discord shows them', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    const preview = await w.provisioning.preview(day.id, hj(PEOPLE.ash));
    expect(preview.channels.map((c) => c.name)).toEqual(['day-staff', 'head-judges', 'lc-floor', 'lc-penalties']);
  });

  it('hides a duplicate-name problem about channels the head judge can’t see', async () => {
    w = provisioningWorld();
    const { day, vgc } = seedDay();
    w.days.patchEvent(day.id, vgc.id, { slug: 'staff' });
    const custom = w.days.createBlueprint({
      ...DEFAULT_BLUEPRINT,
      name: 'Clash',
      channels: [...DEFAULT_BLUEPRINT.channels, { key: 'clash', scope: 'per_event', kind: 'text', namePattern: 'day-{slug}', audience: 'event_staff', purpose: 'general', topic: null, position: 9 }],
    });
    w.days.patchDay(day.id, { blueprintId: custom.id });
    expect((await w.provisioning.preview(day.id, organizer)).problems).toContainEqual({ code: 'duplicate_channel_name', name: 'day-staff', keys: ['clash', 'day-staff'] });
    expect((await w.provisioning.preview(day.id, hj(PEOPLE.ash))).problems).toEqual([]);
  });

  it('still answers with Discord down, leaving out role-only head judges', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    const dawn = w.directory.create({ displayName: 'Dawn', discordUserId: PEOPLE.dawn });
    w.discord.guilds.get(IDS.guild)!.members.set(PEOPLE.dawn, [IDS.headJudgeRole]);
    w.days.putStaff(day.id, [...w.days.plan(day.id).staff.map((s) => ({ staffMemberId: s.staffMemberId, events: s.events })), { staffMemberId: dawn.id, events: [] }]);
    expect((await w.provisioning.preview(day.id, organizer)).channels.find((c) => c.key === 'head-judges')!.audience.map((a) => a.displayName)).toEqual(['Ash', 'Dawn']);
    w.discord.unavailable = true;
    const down = await w.provisioning.preview(day.id, organizer);
    expect(down.headJudgeRole).toBe('unavailable');
    expect(down.channels.find((c) => c.key === 'head-judges')!.audience.map((a) => a.displayName)).toEqual(['Ash']);
  });

  it('builds the access plan from the principal’s own role', () => {
    w = provisioningWorld();
    const { day } = seedDay();
    const dawn = w.directory.create({ displayName: 'Dawn', discordUserId: PEOPLE.dawn });
    w.days.putStaff(day.id, [...w.days.plan(day.id).staff.map((s) => ({ staffMemberId: s.staffMemberId, events: s.events })), { staffMemberId: dawn.id, events: [] }]);
    const plan = w.provisioning.accessPlan(day.id, hj(PEOPLE.dawn, true));
    expect(plan.channels.find((c) => c.key === 'head-judges')!.audienceUserIds).toContain(PEOPLE.dawn);
  });
});

describe('orphans', () => {
  async function withOrphan() {
    const d = seedDay();
    await open(d.day.id);
    const gateway = w.discord.create(BOT_TOKEN).gateway;
    const categoryId = w.days.plan(d.day.id).day.categoryId!;
    const orphan = await gateway.createChannel(IDS.guild, { name: 'random', parentId: categoryId, overwrites: [] });
    await w.provisioning.sync(d.day.id);
    await w.jobs.runDue();
    return { ...d, orphan, categoryId, gateway };
  }

  it('adopts an orphan for a missing channel, which the next sync corrects', async () => {
    w = provisioningWorld();
    const { day, lc, orphan } = await withOrphan();
    expect(() => w.provisioning.adoptOrphan(day.id, orphan, { key: 'floor', eventId: lc.id })).toThrow(expect.objectContaining({ code: 'already_provisioned' }));
    expect(() => w.provisioning.adoptOrphan(day.id, orphan, { key: 'nope', eventId: null })).toThrow(expect.objectContaining({ code: 'unknown_key' }));
    expect(() => w.provisioning.adoptOrphan(day.id, 'x', { key: 'floor', eventId: lc.id })).toThrow(expect.objectContaining({ code: 'not_found' }));
    const floor = w.channel('lc-floor').id;
    w.discord.channels.delete(floor);
    await w.provisioning.sync(day.id);
    w.discord.failOn((call) => (call.method === 'createChannel' ? 'unavailable' : null));
    await w.jobs.runDue();
    w.discord.failOn(null);
    w.provisioning.adoptOrphan(day.id, orphan, { key: 'floor', eventId: lc.id });
    await w.provisioning.sync(day.id);
    await w.jobs.runDue();
    expect(w.discord.channels.get(orphan)!.name).toBe('lc-floor');
    expect(w.staffViewers('lc-floor')).toEqual([PEOPLE.ash, PEOPLE.brock].sort());
    expect(w.provisioning.orphans(day.id)).toEqual([]);
  });

  it('deletes an orphan still in the category, and leaves a moved one alone', async () => {
    w = provisioningWorld();
    const { day, orphan, gateway } = await withOrphan();
    const other = await gateway.createChannel(IDS.guild, { name: 'other', parentId: w.days.plan(day.id).day.categoryId!, overwrites: [] });
    await w.provisioning.sync(day.id);
    await w.jobs.runDue();
    await w.provisioning.deleteOrphan(day.id, orphan);
    expect(w.discord.channels.has(orphan)).toBe(false);
    const elsewhere = await gateway.createCategory(IDS.guild, { name: 'elsewhere', overwrites: [] });
    await gateway.updateChannel(other, { parentId: elsewhere });
    await expect(w.provisioning.deleteOrphan(day.id, other)).rejects.toMatchObject({ status: 409, code: 'orphan_moved' });
    expect(w.discord.channels.has(other)).toBe(true);
    expect(w.provisioning.orphans(day.id)).toEqual([]);
    await expect(w.provisioning.deleteOrphan(day.id, other)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the job’s other paths', () => {
  it('skips the intro and panel when the blueprint has no such channels', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    const bare = w.days.createBlueprint({ ...DEFAULT_BLUEPRINT, name: 'Bare', channels: DEFAULT_BLUEPRINT.channels.filter((c) => c.scope === 'per_event') });
    w.days.patchDay(day.id, { blueprintId: bare.id });
    const { jobId } = await w.provisioning.open(day.id);
    await w.jobs.runDue();
    expect(w.jobs.get(jobId)!.state).toBe('succeeded');
    expect(w.discord.messages.size).toBe(0);
    expect(w.jobs.events(jobId).filter((e) => e.message.startsWith('The blueprint has no day channel'))).toHaveLength(2);
  });

  it('fails a sync before creating when the guild is full', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    await open(day.id);
    w.discord.channels.delete(w.channel('vgc-floor').id);
    for (let i = 0; i < 494; i++) w.discord.channels.set(`f${i}`, { id: `f${i}`, guildId: IDS.guild, type: 'text', name: `f${i}`, parentId: null, topic: null, position: i, overwrites: [] });
    const { jobId } = w.provisioning.sync(day.id);
    await w.jobs.runDue();
    expect(w.jobs.get(jobId)!.error).toMatch(/^channel_limit/);
  });

  it('refuses a sync for an unknown day and a job without a bound guild', async () => {
    w = provisioningWorld();
    expect(() => w.provisioning.sync(999)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('counts an Administrator-holding bot as holding every permission', async () => {
    w = provisioningWorld({ botPermissions: P.Administrator });
    const { day } = seedDay();
    await open(day.id);
    expect(w.staffViewers('lc-floor')).toEqual([PEOPLE.ash, PEOPLE.brock].sort());
    void ADMIN_ROLE;
  });
});

describe('more drift and refusals', () => {
  it('puts the category’s overwrites and a channel’s topic back, and strips members from a channel the plan no longer has', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    await open(day.id);
    const categoryId = w.days.plan(day.id).day.categoryId!;
    w.discord.forceOverwrites(categoryId, []);
    w.discord.channels.get(w.channel('lc-floor').id)!.topic = 'hand-edited';
    // A recorded channel whose key the plan no longer has (never produced by Genie's own edits): kept, emptied.
    const gateway = w.discord.create(BOT_TOKEN).gateway;
    const stale = await gateway.createChannel(IDS.guild, { name: 'stale', parentId: categoryId, overwrites: w.channel('lc-floor').overwrites });
    w.database.sqlite
      .prepare("INSERT INTO provisioned_channel (day_id, guild_id, event_id, blueprint_channel_key, discord_channel_id, applied_overwrites_hash, state, created_at, updated_at) VALUES (?, ?, NULL, 'gone', ?, '', 'present', 0, 0)")
      .run(day.id, IDS.guild, stale);
    const { jobId } = w.provisioning.sync(day.id);
    await w.jobs.runDue();
    expect(w.jobs.get(jobId)!.state).toBe('succeeded');
    expect(w.staffViewers('🏆 Sat Oct 17 · October LC')).toEqual([]);
    expect(w.discord.channels.get(categoryId)!.overwrites).not.toEqual([]);
    expect(w.channel('lc-floor').topic).toBeNull();
    expect(w.staffViewers('stale')).toEqual([]);
    expect(w.discord.channels.has(stale)).toBe(true);
  });

  it('refuses a day with more channels than a category holds', async () => {
    w = provisioningWorld();
    const many = w.days.createBlueprint({
      ...DEFAULT_BLUEPRINT,
      name: 'Many',
      channels: Array.from({ length: 8 }, (_, i) => ({ key: `c${i}`, scope: 'per_event' as const, kind: 'text' as const, namePattern: `{slug}-c${i}`, audience: 'event_staff' as const, purpose: 'floor' as const, topic: null, position: i })),
    });
    const { day } = w.days.createDay({ date: '2026-10-17', title: 'Big', blueprintId: many.id });
    for (let i = 0; i < 7; i++) w.days.addEvent(day.id, { name: `E${i}`, game: 'tcg', startTime: '10:00' });
    await expect(w.provisioning.open(day.id)).rejects.toMatchObject({ data: { problems: [{ code: 'category_limit', needed: 56, max: 50 }] } });
  });

  it('fails a job when the roles aren’t mapped or the bot left the guild', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    await open(day.id);
    w.discord.removeMember(IDS.guild, w.discord.applications.get(IDS.app)!.botUserId);
    const { jobId } = w.provisioning.sync(day.id);
    await w.jobs.runDue();
    expect(w.jobs.get(jobId)!.error).toBe('bot_not_in_guild');
  });

  it('deletes an empty stray category, and answers 503 when Discord is down', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    w.discord.failNext('lost_answer');
    await w.provisioning.open(day.id);
    await w.jobs.runDue();
    w.provisioning.sync(day.id);
    await w.jobs.runDue();
    const [stray] = w.provisioning.orphans(day.id);
    w.discord.unavailable = true;
    await expect(w.provisioning.deleteOrphan(day.id, stray!.discordChannelId)).rejects.toMatchObject({ status: 503 });
    w.discord.unavailable = false;
    await w.provisioning.deleteOrphan(day.id, stray!.discordChannelId);
    expect(w.discord.channels.has(stray!.discordChannelId)).toBe(false);
  });
});

describe('Discord failing at the edges', () => {
  it('answers 503 when the delete itself fails, and keeps the orphan listed', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    await open(day.id);
    const orphan = await w.discord.create(BOT_TOKEN).gateway.createChannel(IDS.guild, { name: 'random', parentId: w.days.plan(day.id).day.categoryId!, overwrites: [] });
    w.provisioning.sync(day.id);
    await w.jobs.runDue();
    w.discord.failOn((call) => (call.method === 'deleteChannel' ? 'unavailable' : null));
    await expect(w.provisioning.deleteOrphan(day.id, orphan)).rejects.toMatchObject({ status: 503 });
    expect(w.provisioning.orphans(day.id)).toHaveLength(1);
  });

  it('posts a new intro when the recorded one was deleted by hand', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    await open(day.id);
    const intro = [...w.discord.messages.values()].find((m) => m.channelId === w.channel('day-staff').id)!;
    w.discord.messages.delete(intro.id);
    w.database.sqlite.prepare("UPDATE provisioned_channel SET message_pinned = 0 WHERE blueprint_channel_key = 'day-staff'").run();
    // The fake answers a pin of a gone message the way Discord does.
    w.discord.failOn((call) => {
      if (call.method === 'pinMessage' && !w.discord.messages.has(call.target)) throw new Error('pinMessage failed: Unknown Message');
      return null;
    });
    w.provisioning.sync(day.id);
    await w.jobs.runDue();
    w.discord.failOn(null);
    w.provisioning.sync(day.id);
    await w.jobs.runDue();
    const intros = [...w.discord.messages.values()].filter((m) => m.channelId === w.channel('day-staff').id);
    expect(intros).toHaveLength(1);
    expect(intros[0]!.pinned).toBe(true);
  });
});

describe('unexpected errors', () => {
  it('passes an unexpected error through instead of calling it Discord being down', async () => {
    w = provisioningWorld();
    const { day } = seedDay();
    await open(day.id);
    w.discord.channels.set('orphan', { id: 'orphan', guildId: IDS.guild, type: 'text', name: 'orphan', parentId: w.days.plan(day.id).day.categoryId, topic: null, position: 0, overwrites: [] });
    w.provisioning.sync(day.id);
    await w.jobs.runDue();
    const original = w.discord.create;
    w.discord.create = (token) => {
      const port = original(token);
      const boom = async () => {
        throw new TypeError('a bug');
      };
      return { ...port, gateway: { ...port.gateway, getGuild: boom, getChannel: boom } };
    };
    const { day: other } = w.days.createDay({ date: '2026-10-18', title: 'Other' });
    await expect(w.provisioning.open(other.id)).rejects.toThrow(TypeError);
    await expect(w.provisioning.preview(other.id, null)).rejects.toThrow(TypeError);
    await expect(w.provisioning.deleteOrphan(day.id, 'orphan')).rejects.toThrow(TypeError);
  });
});

describe('channel privacy over random days', () => {
  const people = [PEOPLE.ash, PEOPLE.brock, PEOPLE.misty, PEOPLE.dawn, PEOPLE.gary];
  const roles = ['headjudge', 'judge', 'scorekeeper'] as const;
  const assignment = fc.record({
    onDay: fc.boolean(),
    linked: fc.boolean(),
    roleHolder: fc.boolean(),
    roles: fc.array(fc.option(fc.constantFrom(...roles), { nil: null }), { minLength: 2, maxLength: 2 }),
  });
  const scenario = fc.record({
    nosend: fc.boolean(),
    sendRoleFor: fc.subarray(people),
    steps: fc.array(fc.array(assignment, { minLength: 5, maxLength: 5 }), { minLength: 1, maxLength: 3 }),
  });

  it('gives each channel exactly its audience, through any sequence of changes', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ nosend, sendRoleFor, steps }) => {
        w = provisioningWorld({ everyone: nosend ? 'nosend' : 'default' });
        try {
          const guild = w.discord.guilds.get(IDS.guild)!;
          w.discord.addRole(IDS.guild, { id: '200000000000000020', name: 'Sender', permissions: P.SendMessages | P.ViewChannel });
          const ids = people.map((u, i) => w.directory.create({ displayName: `P${i}`, playerId: String(1000 + i) }).id);
          const { day } = w.days.createDay({ date: '2026-10-17', title: 'Random' });
          const events = [w.days.addEvent(day.id, { name: 'A', game: 'tcg', startTime: '10:00' }), w.days.addEvent(day.id, { name: 'B', game: 'vgc', startTime: '11:00' })];
          let opened = false;
          for (const step of steps) {
            step.forEach((a, i) => {
              const roleIds = [...(a.roleHolder ? [IDS.headJudgeRole] : []), ...(sendRoleFor.includes(people[i]!) ? ['200000000000000020'] : [])];
              guild.members.set(people[i]!, roleIds);
              const current = w.directory.get(ids[i]!)!;
              const want = a.linked ? people[i]! : null;
              if (current.discordUserId !== want) w.directory.update(ids[i]!, { discordUserId: want });
            });
            w.days.putStaff(
              day.id,
              step.flatMap((a, i) => (a.onDay ? [{ staffMemberId: ids[i]!, events: a.roles.flatMap((r, e) => (r ? [{ eventId: events[e]!.id, role: r }] : [])) }] : [])),
            );
            const plan = w.days.plan(day.id);
            if (!opened) {
              if (plan.staff.some((s) => s.linkState !== 'linked')) continue;
              await w.provisioning.open(day.id);
              opened = true;
            } else {
              w.provisioning.sync(day.id);
            }
            await w.jobs.runDue();
            const preview = await w.provisioning.preview(day.id, null);
            for (const c of preview.channels) {
              const users = c.audience.map((a) => w.directory.get(a.staffMemberId)!.discordUserId!).sort();
              expect(w.staffViewers(c.name), `${c.name} after step`).toEqual(users);
            }
          }
        } finally {
          w.close();
          w = provisioningWorld();
        }
      }),
      { seed: 20261014, numRuns: 60 },
    );
    // Sixty seeded days take about 7 s on a CI runner under coverage: past the default 5 s, so it gets its own limit.
  }, 30_000);
});
