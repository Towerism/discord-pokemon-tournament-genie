import { describe, expect, it } from 'vitest';
import { everyone, member } from '../../../../shared/discord/overwrites';
import { INVITE_PERMISSIONS, PERMISSION_BITS as P } from '../../../../shared/discord/permissions';
import { DiscordPermissionError } from '../port';
import { createFakeDiscord } from './index';

const GUILD = '400000000000000001';
const APP = '300000000000000001';
const TOKEN = 'fake-bot-token-history-test';
const ASH = '100000000000000001';
const MISTY = '100000000000000002';
const ALL = INVITE_PERMISSIONS.reduce((bits, name) => bits | P[name], 0n);
const DAY = 86_400_000;

async function world(botPermissions = ALL) {
  const discord = createFakeDiscord();
  let now = 1_760_000_000_000;
  discord.setNow(() => now);
  discord.addApplication({ id: APP, token: TOKEN });
  discord.addGuild({ id: GUILD, name: 'G', everyonePermissions: P.ViewChannel | P.SendMessages | P.ReadMessageHistory, ownerId: '100000000000000099' });
  discord.inviteBot(APP, GUILD, { permissions: botPermissions });
  discord.addMember(GUILD, ASH, [], { displayName: 'Ash' });
  discord.addMember(GUILD, MISTY, [], { displayName: 'Misty' });
  const gateway = discord.create(TOKEN).gateway;
  const bot = discord.applications.get(APP)!.botUserId;
  const category = await gateway.createCategory(GUILD, { name: 'day', overwrites: [] });
  const channel = await gateway.createChannel(GUILD, {
    name: 'lc-floor',
    parentId: category,
    overwrites: [everyone(GUILD, { deny: P.ViewChannel }), member(bot, { allow: P.ViewChannel | P.SendMessages }), member(ASH, { allow: P.ViewChannel | P.SendMessages | P.ReadMessageHistory })],
  });
  return { discord, gateway, bot, channel, advance: (ms: number) => (now += ms) };
}

describe('the fake’s history', () => {
  it('pages 100 messages at a time, newest first, with authors, times, edits and replies', async () => {
    const { discord, gateway, channel, advance } = await world();
    const ids: string[] = [];
    for (let i = 0; i < 250; i++) {
      ids.push(discord.post(ASH, channel, { content: `m${i}`, ...(i === 5 ? { replyTo: ids[0] } : {}) }));
      advance(1000);
    }
    discord.editAsAuthor(ids[3]!, 'm3 (edited)');

    const first = (await gateway.readHistory(channel))!;
    expect(first).toHaveLength(100);
    expect(first[0]!.id).toBe(ids[249]);
    const second = (await gateway.readHistory(channel, first.at(-1)!.id))!;
    const third = (await gateway.readHistory(channel, second.at(-1)!.id))!;
    expect(third).toHaveLength(50);
    expect(await gateway.readHistory(channel, third.at(-1)!.id)).toEqual([]);

    const edited = third.find((m) => m.id === ids[3])!;
    expect(edited).toMatchObject({ authorId: ASH, authorName: 'Ash', authorBot: false, content: 'm3 (edited)', referencedMessageId: null });
    expect(edited.editedAt).toBeGreaterThan(edited.createdAt);
    expect(third.find((m) => m.id === ids[5])!.referencedMessageId).toBe(ids[0]);
    expect(await gateway.getLatestMessageId(channel)).toBe(ids[249]);
  });

  it('answers null and gone once a channel is deleted, and null for an empty channel', async () => {
    const { gateway, channel } = await world();
    expect(await gateway.getLatestMessageId(channel)).toBeNull();
    await gateway.deleteChannel(channel, 'test');
    expect(await gateway.readHistory(channel)).toBeNull();
    expect(await gateway.getLatestMessageId(channel)).toBe('gone');
  });

  it('refuses a member who may not send, in the channel and its threads', async () => {
    const { discord, channel } = await world();
    expect(() => discord.post(MISTY, channel, { content: 'hi' })).toThrow(DiscordPermissionError);
    const thread = discord.addThread(channel, { type: 'public', name: 'appeal' });
    // Ash has Send but not Send in Threads.
    expect(() => discord.post(ASH, thread, { content: 'hi' })).toThrow(DiscordPermissionError);
    expect(() => discord.openThread(ASH, channel, { type: 'public', name: 'x' })).toThrow(DiscordPermissionError);
  });
});

describe('the fake’s threads', () => {
  it('lists every thread of a channel, archived and private ones too, and reads each', async () => {
    const { discord, gateway, channel, bot } = await world();
    const pub = discord.addThread(channel, { type: 'public', name: 'pub' });
    const archived = discord.addThread(channel, { type: 'public', archived: true, name: 'old' });
    const priv = discord.addThread(channel, { type: 'private', memberIds: [ASH], name: 'secret' });
    discord.post(bot, priv, { content: 'in the private thread' });
    const threads = await gateway.listThreads(GUILD, channel);
    expect(threads.map((t) => [t.id, t.name, t.type, t.archived, t.parentId])).toEqual([
      [pub, 'pub', 'public', false, channel],
      [archived, 'old', 'public', true, channel],
      [priv, 'secret', 'private', false, channel],
    ]);
    expect((await gateway.readHistory(priv))!.map((m) => m.content)).toEqual(['in the private thread']);
  });

  it('refuses to list threads without Manage Threads, as the archived-private listing does', async () => {
    const { gateway, channel } = await world(ALL & ~P.ManageThreads);
    await expect(gateway.listThreads(GUILD, channel)).rejects.toBeInstanceOf(DiscordPermissionError);
  });
});

describe('the fake’s attachments', () => {
  it('re-resolves an attachment to a fresh URL that the CDN serves until it expires', async () => {
    const { discord, gateway, channel, advance } = await world();
    const id = discord.post(ASH, channel, { content: 'deck', attachments: [{ filename: 'deck.png', data: Buffer.from('png-bytes'), contentType: 'image/png' }] });
    const [message] = (await gateway.readHistory(channel))!;
    const attachment = message!.attachments[0]!;
    expect(attachment).toMatchObject({ filename: 'deck.png', size: 9, contentType: 'image/png' });

    const resolved = await gateway.resolveAttachment(channel, id, attachment.id);
    if (!('url' in resolved)) throw new Error('not resolved');
    expect(resolved.bytes).toBe(9);
    expect(discord.cdnServe(resolved.url)).toMatchObject({ status: 200, body: Buffer.from('png-bytes') });
    advance(DAY + 1);
    expect(discord.cdnServe(resolved.url).status).toBe(404);
    const again = await gateway.resolveAttachment(channel, id, attachment.id);
    if (!('url' in again)) throw new Error('not resolved');
    expect(again.url).not.toBe(resolved.url);
    expect(discord.cdnServe(again.url).status).toBe(200);
  });

  it('answers message_deleted and not_found', async () => {
    const { discord, gateway, channel } = await world();
    const id = discord.post(ASH, channel, { content: 'x', attachments: [{ filename: 'a.txt', data: Buffer.from('a') }] });
    expect(await gateway.resolveAttachment(channel, id, '1')).toEqual({ error: 'not_found' });
    discord.messages.delete(id);
    expect(await gateway.resolveAttachment(channel, id, '1')).toEqual({ error: 'message_deleted' });
  });
});
