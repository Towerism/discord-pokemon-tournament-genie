import { createRedactor, silentLogger } from '@towerism/selfhost-kit';
import { type FakeClock, fakeClock } from '@towerism/selfhost-kit/testing';
import { PERMISSION_BITS as P } from '../../shared/discord/permissions';
import type { OpenDatabase } from '../../server/db/client';
import { type DirectoryService, createDirectoryService } from '../../server/modules/directory';
import { type FakeDiscord, createFakeDiscord } from '../../server/modules/discord/fake';
import { type EventDaysService, createEventDaysService } from '../../server/modules/event-days';
import { type Jobs, createJobs } from '../../server/modules/jobs/jobs';
import { createSqliteJobStore } from '../../server/modules/jobs/sqlite-store';
import { type ProvisioningService, createProvisioningService } from '../../server/modules/provisioning';
import { createSetupStore } from '../../server/modules/setup/store';
import { freshDb } from './db';
import { ALL_PERMISSIONS, BOT_TOKEN, IDS } from './discord-world';

export const TZ = 'America/Chicago';
export const ADMIN_ROLE = '200000000000000009';
/** Guild members by name; `outsider` is in the guild but on no day. */
export const PEOPLE = {
  ash: '100000000000000101',
  brock: '100000000000000102',
  misty: '100000000000000103',
  dawn: '100000000000000104',
  gary: '100000000000000105',
  outsider: '100000000000000106',
  admin: '100000000000000107',
  organizer: IDS.organizer,
} as const;

export interface ProvisioningWorld {
  database: OpenDatabase;
  clock: FakeClock;
  discord: FakeDiscord;
  jobs: Jobs;
  directory: DirectoryService;
  days: EventDaysService;
  provisioning: ProvisioningService;
  /** More references the directory must respect (a penalty naming a judge); modules built later add theirs. */
  referencedBy: ((staffMemberId: number) => boolean)[];
  /** The Discord user IDs who can view the day channel named `name` (or the category, by its name). */
  viewers(name: string): string[];
  /** Like `viewers`, without administrators, the owner, organizers and the bot. */
  staffViewers(name: string): string[];
  channel(name: string): ReturnType<FakeDiscord['channelsOf']>[number];
  close(): void;
}

/**
 * A store guild (default `@everyone` base with Send, or `nosend`), the bot with exactly the 13 invite permissions,
 * an Administrator, an organizer-role holder, and staff by name; and Genie's modules on a fresh database.
 */
export function provisioningWorld(opts: { everyone?: 'default' | 'nosend'; botPermissions?: bigint } = {}): ProvisioningWorld {
  const database = freshDb();
  const clock = fakeClock(1_000_000);
  const discord = createFakeDiscord();
  discord.addApplication({ id: IDS.app, token: BOT_TOKEN });
  const everyone = opts.everyone === 'nosend' ? P.ViewChannel | P.ReadMessageHistory : P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.AddReactions | P.CreatePublicThreads;
  discord.addGuild({ id: IDS.guild, name: 'Pallet Town Games', everyonePermissions: everyone, ownerId: IDS.owner });
  discord.addRole(IDS.guild, { id: IDS.organizerRole, name: 'Organizer', position: 2 });
  discord.addRole(IDS.guild, { id: IDS.headJudgeRole, name: 'Head judge', position: 1 });
  discord.addRole(IDS.guild, { id: ADMIN_ROLE, name: 'Admin', position: 3, permissions: P.Administrator });
  discord.inviteBot(IDS.app, IDS.guild, { permissions: opts.botPermissions ?? ALL_PERMISSIONS, position: 5 });
  discord.addMember(IDS.guild, IDS.owner, [], { displayName: 'Owner' });
  discord.addMember(IDS.guild, PEOPLE.organizer, [IDS.organizerRole], { displayName: 'Oak' });
  discord.addMember(IDS.guild, PEOPLE.admin, [ADMIN_ROLE], { displayName: 'Admin' });
  for (const [name, id] of Object.entries(PEOPLE)) {
    if (id === PEOPLE.organizer || id === PEOPLE.admin) continue;
    discord.addMember(IDS.guild, id, [], { displayName: name[0]!.toUpperCase() + name.slice(1), username: name });
  }

  const referencedBy: ((staffMemberId: number) => boolean)[] = [];
  const jobs = createJobs({ store: createSqliteJobStore(database.db), clock, logger: silentLogger, redactor: createRedactor({ extraKeys: [] }) });
  let days: EventDaysService | null = null;
  const directory = createDirectoryService({
    db: database.db,
    clock,
    logger: silentLogger,
    onLinkChanged: (id) => days!.onLinkChanged(id),
    isReferenced: (id) => days!.isReferenced(id) || referencedBy.some((isJudge) => isJudge(id)),
  });
  days = createEventDaysService({
    db: database.db,
    clock,
    logger: silentLogger,
    timeZone: TZ,
    guildId: () => IDS.guild,
    directory,
    enqueueSync: (dayId) => jobs.enqueueUnlessQueued({ kind: 'sync', dayId }).jobId,
    currentSeason: () => createSetupStore(database.db).currentSeason(),
  });
  const provisioning = createProvisioningService({
    db: database.db,
    clock,
    logger: silentLogger,
    eventDays: days,
    jobs,
    gateway: () => discord.create(BOT_TOKEN).gateway,
    binding: () => ({ guildId: IDS.guild, organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole }),
  });
  provisioning.register();

  const channel = (name: string) => {
    const found = discord.channelsOf(IDS.guild).filter((c) => c.name === name);
    if (found.length !== 1) throw new Error(`${found.length} channels named ${name}`);
    return found[0]!;
  };
  const guild = discord.guilds.get(IDS.guild)!;
  const viewers = (name: string) => {
    const c = channel(name);
    return [...guild.members.keys()].filter((u) => discord.permissionsFor(u, c.id) & P.ViewChannel).sort();
  };
  const excluded = new Set([IDS.owner, PEOPLE.organizer, PEOPLE.admin, discord.applications.get(IDS.app)!.botUserId]);
  return {
    database,
    clock,
    discord,
    jobs,
    directory,
    days,
    provisioning,
    referencedBy,
    viewers,
    staffViewers: (name) => viewers(name).filter((u) => !excluded.has(u)),
    channel,
    close: () => database.close(),
  };
}
