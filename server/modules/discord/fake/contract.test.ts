import { describePermissionContract, type PermissionSubject } from '../../../../test/contract/discord-permissions';
import { createFakeDiscord } from './index';

const GUILD = '400000000000000001';
const APP = '300000000000000001';
const TOKEN = 'fake-bot-token-contract';

/** A fresh fake per case: the case's `@everyone` base, its roles, its members and `genie`'s role. */
const fakeSubject: PermissionSubject = {
  name: 'in-memory fake',
  async world(guild) {
    const discord = createFakeDiscord();
    const app = discord.addApplication({ id: APP, token: TOKEN });
    discord.addGuild({ id: GUILD, name: 'Contract guild', everyonePermissions: guild.everyone });
    const ids = new Map<string, string>([
      ['everyone', GUILD],
      ['member:genie', app.botUserId],
    ]);
    let n = 0;
    for (const r of guild.roles) {
      const id = `2000000000000001${String(++n).padStart(2, '0')}`;
      ids.set(r.key, id);
      discord.addRole(GUILD, { id, name: r.key, permissions: r.permissions, position: r.position });
    }
    discord.inviteBot(APP, GUILD, { permissions: guild.genieRole, position: 50 });
    for (const m of [...guild.members, { key: 'member:unknown', roles: [] }]) {
      const id = `1000000000000001${String(++n).padStart(2, '0')}`;
      ids.set(m.key, id);
      discord.addMember(GUILD, id, m.roles.map((k) => ids.get(k)!));
    }
    const id = (key: string) => {
      const found = ids.get(key);
      if (!found) throw new Error(`No ID for ${key}`);
      return found;
    };
    const { gateway } = discord.create(TOKEN);
    let parent: string | null = null;
    return {
      gateway,
      guildId: GUILD,
      id,
      async parent() {
        parent ??= await gateway.createCategory(GUILD, { name: 'contract', overwrites: [] });
        return parent;
      },
      async placeAsAdmin(channelId, overwrites) {
        discord.forceOverwrites(channelId, overwrites);
      },
      async addThread(channelId, thread) {
        return discord.addThread(channelId, { type: thread.type, archived: thread.archived, memberIds: thread.memberKeys.map(id) });
      },
      async effective(memberKey, channelId, threadId) {
        return discord.permissionsFor(id(memberKey), channelId, threadId);
      },
      async cleanup() {},
    };
  },
};

describePermissionContract(fakeSubject);
