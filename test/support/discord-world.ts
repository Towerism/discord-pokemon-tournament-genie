import { randomBytes } from 'node:crypto';
import { createVault, stringVault } from '@towerism/selfhost-kit';
import { INVITE_PERMISSIONS, PERMISSION_BITS } from '../../shared/discord/permissions';
import { createFakeDiscord } from '../../server/modules/discord/fake';

/** Synthetic values only: the secret scanners search for these prefixes. */
export const IDS = {
  app: '300000000000000001',
  guild: '400000000000000001',
  otherGuild: '400000000000000002',
  owner: '100000000000000001',
  organizer: '100000000000000002',
  member: '100000000000000003',
  outsider: '100000000000000004',
  organizerRole: '200000000000000001',
  headJudgeRole: '200000000000000002',
} as const;
export const BOT_TOKEN = 'fake-bot-token-0123456789';
export const CLIENT_SECRET = 'fake-client-secret-0123456789';
export const ALL_PERMISSIONS = INVITE_PERMISSIONS.reduce((sum, name) => sum | PERMISSION_BITS[name], 0n);

/**
 * The usual store server: the application, the guild with both roles, an owner, an organizer, a plain member,
 * and the bot invited with exactly the invite permissions above both roles.
 */
export function storeWorld() {
  const discord = createFakeDiscord();
  discord.addApplication({ id: IDS.app, token: BOT_TOKEN });
  discord.addGuild({ id: IDS.guild, name: 'Pallet Town Games' });
  discord.addRole(IDS.guild, { id: IDS.organizerRole, name: 'Organizer', position: 2 });
  discord.addRole(IDS.guild, { id: IDS.headJudgeRole, name: 'Head judge', position: 1 });
  discord.inviteBot(IDS.app, IDS.guild, { permissions: ALL_PERMISSIONS, position: 5 });
  discord.addMember(IDS.guild, IDS.owner);
  discord.addMember(IDS.guild, IDS.organizer, [IDS.organizerRole]);
  discord.addMember(IDS.guild, IDS.member);
  return discord;
}

/** A vault with a fresh random key, built the way server/utils builds Genie's. */
export function testVault() {
  return stringVault(createVault({ key: randomBytes(32).toString('base64'), label: 'vault' }));
}
