import { describe, expect, it } from 'vitest';
import { everyone, member } from '../../../../shared/discord/overwrites';
import { PERMISSION_BITS as P } from '../../../../shared/discord/permissions';
import { DiscordPermissionError, DiscordUnavailableError } from '../port';
import { createFakeDiscord } from './index';

const GUILD = '400000000000000001';
const APP = '300000000000000001';
const TOKEN = 'fake-bot-token-fake-test';
const MOST = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.AttachFiles | P.ManageChannels | P.ManageRoles;

function world(botPermissions = MOST) {
  const discord = createFakeDiscord();
  discord.addApplication({ id: APP, token: TOKEN });
  discord.addGuild({ id: GUILD, name: 'G', everyonePermissions: P.ViewChannel | P.SendMessages, ownerId: '100000000000000099' });
  discord.inviteBot(APP, GUILD, { permissions: botPermissions });
  discord.addMember(GUILD, '100000000000000001', [], { displayName: 'Ash Ketchum', username: 'ash' });
  discord.addMember(GUILD, '100000000000000002', [], { displayName: 'Ashley', username: 'ashley' });
  discord.addMember(GUILD, '100000000000000003', [], { displayName: 'Ashbot', username: 'ashbot', bot: true });
  return { discord, gateway: discord.create(TOKEN).gateway };
}

describe('the fake gateway', () => {
  it('fails an injected unavailable write without applying it', async () => {
    const { discord, gateway } = world();
    discord.failNext('unavailable');
    await expect(gateway.createCategory(GUILD, { name: 'day', overwrites: [] })).rejects.toBeInstanceOf(DiscordUnavailableError);
    expect(discord.channelsOf(GUILD)).toHaveLength(0);
  });

  it('applies a lost-answer write, then throws', async () => {
    const { discord, gateway } = world();
    discord.failNext('lost_answer');
    await expect(gateway.createCategory(GUILD, { name: 'day', overwrites: [] })).rejects.toBeInstanceOf(DiscordUnavailableError);
    expect(discord.channelsOf(GUILD).map((c) => c.name)).toEqual(['day']);
  });

  it('checks a gated write against the state at release', async () => {
    const { discord, gateway } = world();
    const category = await gateway.createCategory(GUILD, { name: 'day', overwrites: [] });
    let release!: () => void;
    discord.writeGate = new Promise((resolve) => (release = resolve));
    const pending = gateway.setOverwrites(category, [everyone(GUILD, { deny: P.ViewChannel })]);
    const botRole = discord.guilds.get(GUILD)!.roles.find((r) => r.managed)!;
    botRole.permissions &= ~P.ManageRoles;
    discord.writeGate = null;
    release();
    await expect(pending).rejects.toBeInstanceOf(DiscordPermissionError);
  });

  it('refuses overwrites from a bot without Manage Roles', async () => {
    const { gateway } = world(MOST & ~P.ManageRoles);
    await expect(gateway.createCategory(GUILD, { name: 'day', overwrites: [everyone(GUILD, { deny: P.ViewChannel })] })).rejects.toBeInstanceOf(
      DiscordPermissionError,
    );
    await expect(gateway.createCategory(GUILD, { name: 'bare', overwrites: [] })).resolves.toBeTypeOf('string');
  });

  it('records every mutating call that reached it', async () => {
    const { discord, gateway } = world();
    const category = await gateway.createCategory(GUILD, { name: 'day', overwrites: [] });
    await gateway.getChannel(category);
    await gateway.updateChannel(category, { name: 'renamed' });
    expect(discord.mutations.map((m) => m.method)).toEqual(['createCategory', 'updateChannel']);
  });

  it('searches members by name prefix and reports bots', async () => {
    const { gateway } = world();
    const found = await gateway.searchMembers(GUILD, 'ash', 10);
    expect(found.map((m) => [m.displayName, m.bot])).toEqual([
      ['Ash Ketchum', false],
      ['Ashley', false],
      ['Ashbot', true],
    ]);
  });

  it('leaves a deleted category’s channels in place without a parent', async () => {
    const { gateway } = world();
    const category = await gateway.createCategory(GUILD, { name: 'day', overwrites: [] });
    const channel = await gateway.createChannel(GUILD, { name: 'floor', parentId: category, overwrites: [member('100000000000000001', { allow: P.ViewChannel })] });
    expect(await gateway.deleteChannel(category, 'test')).toBe('deleted');
    expect(await gateway.deleteChannel(category, 'test')).toBe('already_gone');
    expect((await gateway.getChannel(channel))?.parentId).toBeNull();
  });

  it('keeps a moved channel’s own overwrites', async () => {
    const { gateway } = world();
    const a = await gateway.createCategory(GUILD, { name: 'a', overwrites: [] });
    const b = await gateway.createCategory(GUILD, { name: 'b', overwrites: [everyone(GUILD, { deny: P.ViewChannel })] });
    const own = [member('100000000000000001', { allow: P.ViewChannel })];
    const channel = await gateway.createChannel(GUILD, { name: 'floor', parentId: a, overwrites: own });
    await gateway.updateChannel(channel, { parentId: b });
    expect((await gateway.getChannel(channel))?.overwrites).toEqual(own);
  });

  it('reports the guild owner and its channel count', async () => {
    const { gateway } = world();
    await gateway.createCategory(GUILD, { name: 'day', overwrites: [] });
    const guild = await gateway.getGuild(GUILD);
    expect(guild?.ownerId).toBe('100000000000000099');
    expect(guild?.channelCount).toBe(1);
  });

  it('posts and pins messages with buttons', async () => {
    const { discord, gateway } = world();
    const category = await gateway.createCategory(GUILD, { name: 'day', overwrites: [] });
    const channel = await gateway.createChannel(GUILD, { name: 'staff', parentId: category, overwrites: [] });
    const id = await gateway.postMessage(channel, { content: 'hi', buttons: [{ customId: 'x', label: 'Sync' }] });
    await gateway.pinMessage(channel, id);
    expect(discord.messages.get(id)).toMatchObject({ content: 'hi', pinned: true, buttons: [{ customId: 'x', label: 'Sync' }] });
  });
});
