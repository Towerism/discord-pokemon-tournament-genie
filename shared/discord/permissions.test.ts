import { describe, expect, it } from 'vitest';
import { INVITE_PERMISSIONS, PERMISSION_BITS, inviteUrl, missingPermissions } from './permissions';

describe('invite permissions (ADR-0012)', () => {
  it('asks for exactly the 13 permissions, never Administrator', () => {
    expect([...INVITE_PERMISSIONS].sort()).toEqual(
      [
        'AddReactions',
        'AttachFiles',
        'CreatePrivateThreads',
        'CreatePublicThreads',
        'EmbedLinks',
        'ManageChannels',
        'ManageRoles',
        'ManageThreads',
        'ReadMessageHistory',
        'SendMessages',
        'SendMessagesInThreads',
        'UseApplicationCommands',
        'ViewChannel',
      ].sort(),
    );
  });

  it('builds the invite URL with the 13-permission sum and both scopes', () => {
    const url = new URL(inviteUrl('123456789012345678'));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('123456789012345678');
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    // Summed independently from Discord's documented bit positions.
    expect(url.searchParams.get('permissions')).toBe('397553028176');
    expect(BigInt(url.searchParams.get('permissions')!) & PERMISSION_BITS.Administrator).toBe(0n);
  });
});

describe('missingPermissions', () => {
  const all = INVITE_PERMISSIONS.reduce((sum, name) => sum | PERMISSION_BITS[name], 0n);

  it('names nothing when every invite permission is held', () => {
    expect(missingPermissions(all)).toEqual([]);
  });

  it('names each permission that is not held, in invite order', () => {
    const held = all & ~PERMISSION_BITS.AddReactions & ~PERMISSION_BITS.ManageThreads;
    expect(missingPermissions(held)).toEqual(['ManageThreads', 'AddReactions']);
  });

  it('counts Administrator as holding everything', () => {
    expect(missingPermissions(PERMISSION_BITS.Administrator)).toEqual([]);
  });
});
