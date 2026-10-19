import { describe, expect, it } from 'vitest';
import { INVITE_PERMISSIONS, PERMISSION_BITS, bitsOf, inviteUrl, missingDayPermissions, missingPermissions, namesOf } from './permissions';

describe('bitsOf / namesOf', () => {
  it('round-trips names through bits', () => {
    expect(namesOf(bitsOf(['SendMessages', 'ViewChannel', 'MentionEveryone']))).toEqual(['ViewChannel', 'SendMessages', 'MentionEveryone']);
    expect(PERMISSION_BITS.MentionEveryone).toBe(1n << 17n);
  });

  it('refuses an unknown name', () => {
    expect(() => bitsOf(['ViewChanel'])).toThrow('Unknown permission: ViewChanel');
  });
});

describe('invite permissions (ADR-0012, ADR-0016)', () => {
  it('asks for exactly the 14 permissions, never Administrator', () => {
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
        'PinMessages',
        'ReadMessageHistory',
        'SendMessages',
        'SendMessagesInThreads',
        'UseApplicationCommands',
        'ViewChannel',
      ].sort(),
    );
  });

  it('builds the invite URL with the 14-permission sum and both scopes', () => {
    const url = new URL(inviteUrl('123456789012345678'));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('123456789012345678');
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    // Summed independently from Discord's documented bit positions.
    expect(url.searchParams.get('permissions')).toBe('2252197366713424');
    expect(BigInt(url.searchParams.get('permissions')!) & PERMISSION_BITS.Administrator).toBe(0n);
    // Pinning needs Pin Messages, never Manage Messages (bit 13).
    expect(BigInt(url.searchParams.get('permissions')!) & (1n << 13n)).toBe(0n);
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

  it('names Pin Messages for a bot invited with the 13 permissions before it was added', () => {
    expect(missingPermissions(all & ~PERMISSION_BITS.PinMessages)).toEqual(['PinMessages']);
  });
});

describe('missingDayPermissions', () => {
  const all = INVITE_PERMISSIONS.reduce((sum, name) => sum | PERMISSION_BITS[name], 0n);

  it('lets a day open and close without Pin Messages', () => {
    expect(missingDayPermissions(all & ~PERMISSION_BITS.PinMessages)).toEqual([]);
  });

  it('still names every other missing invite permission', () => {
    expect(missingDayPermissions(all & ~PERMISSION_BITS.PinMessages & ~PERMISSION_BITS.CreatePrivateThreads)).toEqual(['CreatePrivateThreads']);
  });

  it('counts Administrator as holding everything', () => {
    expect(missingDayPermissions(PERMISSION_BITS.Administrator)).toEqual([]);
  });
});
