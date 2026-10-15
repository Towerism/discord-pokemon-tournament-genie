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

  it('posts an embed, edits it in place, and answers gone for a deleted message or channel', async () => {
    const { discord, gateway } = world();
    const category = await gateway.createCategory(GUILD, { name: 'day', overwrites: [] });
    const channel = await gateway.createChannel(GUILD, { name: 'lc-penalties', parentId: category, overwrites: [] });
    const embed = { title: 'Penalty #1', fields: [{ name: 'Severity', value: 'Minor' }] };
    const id = await gateway.postMessage(channel, { content: '', embed, buttons: [{ customId: 'e', label: 'Edit' }, { customId: 'v', label: 'Void', style: 'danger' }] });
    expect(discord.messages.get(id)).toMatchObject({ embed, buttons: [{ customId: 'e' }, { customId: 'v', style: 'danger' }] });

    expect(await gateway.editMessage(channel, id, { content: '', embed: { ...embed, title: 'VOIDED · Penalty #1' } })).toBe('edited');
    expect(discord.messages.get(id)).toMatchObject({ embed: { title: 'VOIDED · Penalty #1' }, buttons: [] });

    expect(await gateway.deleteMessage(channel, id)).toBe('deleted');
    expect(discord.messages.has(id)).toBe(false);
    expect(await gateway.deleteMessage(channel, id)).toBe('already_gone');
    expect(await gateway.editMessage(channel, id, { content: 'x' })).toBe('gone');

    const other = await gateway.postMessage(channel, { content: 'y' });
    await gateway.deleteChannel(channel, 'test');
    expect(await gateway.editMessage(channel, other, { content: 'z' })).toBe('gone');
  });

  it('counts every REST call, reads and writes alike', async () => {
    const { discord, gateway } = world();
    const before = discord.restCalls;
    await gateway.getGuild(GUILD);
    await gateway.createCategory(GUILD, { name: 'day', overwrites: [] });
    expect(discord.restCalls - before).toBe(2);
  });
});

describe('the fake bot session', () => {
  it('answers interact with the deferral, the modal, the choices and the ephemeral replies a handler sent', async () => {
    const { discord } = world();
    const modal = { customId: 'genie:penalty:1:2:3', title: 'Penalty', components: [] };
    await discord.create(TOKEN).bot.connect({
      async onInteraction(i, reply) {
        if (i.kind === 'command') return reply.showModal(modal);
        if (i.kind === 'autocomplete') return reply.autocomplete([{ name: 'LC', value: '7' }]);
        await reply.deferEphemeral();
        await reply.ephemeral('Recorded #1 for LC.');
      },
    });
    const base = { id: '1', name: 'penalty', guildId: GUILD, channelId: '2', userId: '3', options: {}, memberRoleIds: [], userDisplayName: 'Ash' };
    expect(await discord.interact({ ...base, kind: 'command' })).toEqual({ ephemeral: [], buttons: [], deferred: false, modal, choices: null });
    expect(await discord.interact({ ...base, kind: 'autocomplete' })).toEqual({ ephemeral: [], buttons: [], deferred: false, modal: null, choices: [{ name: 'LC', value: '7' }] });
    expect(await discord.interact({ ...base, kind: 'modal' })).toEqual({ ephemeral: ['Recorded #1 for LC.'], buttons: [], deferred: true, modal: null, choices: null });
    expect(await discord.dispatch({ ...base, kind: 'modal' })).toEqual(['Recorded #1 for LC.']);
  });
});
