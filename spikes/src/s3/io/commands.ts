import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { ExitError, OUT_DIR, REPO_DIR, guarded, log, runId as newRun, warn, whoAmI } from '../../io/session.js';
import { Api, fromBits, toBits } from '../../io/rest.js';
import { applyCleanup, planCleanup } from '../../shared/cleanup.js';
import { canSnapshot, createLedger, hasUnrestored, markRestored, readLedgers, recordSnapshot, type LedgerHandle } from '../../shared/ledger.js';
import { buildCatalog } from '../catalog.js';
import { buildFixture, changedCases, fixtureJsonSchema, serializeFixture } from '../fixture.js';
import { checkGenieRole, checkRoleOrder, INVITE_PERMISSIONS } from '../preflight.js';
import { libraryDisagreements } from '../report.js';
import { prepareCase, runPass } from '../runner.js';
import { stageEligibility, stagePlan } from '../stage.js';
import { checkStability } from '../stability.js';
import type { PassResult } from '../types.js';
import type { RunContext, RunnerPorts } from '../ports.js';
import { ActAdapter, ArrangeAdapter, CleanupAdapter, ThreadStateAdapter, WriteAdapter, genieRoleId } from './adapters.js';
import type { Config } from '../../shared/config.js';

const FIXTURE_DIR = join(REPO_DIR, 'test', 'fixtures', 'discord-permissions');
const FIXTURE = join(FIXTURE_DIR, 'cases.v1.json');
const SCHEMA = join(FIXTURE_DIR, 'cases.v1.schema.json');
const DISCORD_JS = '14.27.0';

type Bots = { arranger: Api; genie: Api; probeA: Api; probeB: Api };
type Ids = { arranger: string; genie: string; probeA: string; probeB: string };

function bots(c: Config): Bots {
  return {
    arranger: new Api(c.GENIE_SPIKE_ARRANGER_TOKEN!),
    genie: new Api(c.GENIE_SPIKE_GENIE_TOKEN!),
    probeA: new Api(c.GENIE_SPIKE_PROBE_A_TOKEN!),
    probeB: new Api(c.GENIE_SPIKE_PROBE_B_TOKEN!),
  };
}

async function identities(b: Bots): Promise<Ids> {
  const [arranger, genie, probeA, probeB] = await Promise.all([b.arranger, b.genie, b.probeA, b.probeB].map(whoAmI));
  return { arranger: arranger!.id, genie: genie!.id, probeA: probeA!.id, probeB: probeB!.id };
}

type Role = { id: string; name: string; position: number; permissions: string; tags?: { bot_id?: string } };

/** FR-16: genie's managed role is exactly §4.1, nobody's Administrator but the arranger's, role order right. */
export async function preflight(b: Bots, guildId: string, ids: Ids, printInvite?: string): Promise<{ genieRolePermissions: string[] }> {
  const roles = await b.arranger.must<Role[]>('get', `/guilds/${guildId}/roles`);
  const member = (userId: string) => b.arranger.must<{ roles: string[] }>('get', `/guilds/${guildId}/members/${userId}`);
  const managed = (userId: string) => roles.find((r) => r.tags?.bot_id === userId);
  const top = async (userId: string) => {
    const m = await member(userId);
    return Math.max(0, ...roles.filter((r) => m.roles.includes(r.id)).map((r) => r.position));
  };
  const genieRole = managed(ids.genie);
  if (!genieRole) throw new ExitError(3, "genie's managed role not found: is genie invited?");
  const genieMember = await member(ids.genie);
  const genieAdmin = roles.filter((r) => genieMember.roles.includes(r.id)).some((r) => fromBits(r.permissions).includes('Administrator'));
  const arrangerMember = await member(ids.arranger);
  const arrangerAdmin = roles.filter((r) => arrangerMember.roles.includes(r.id)).some((r) => fromBits(r.permissions).includes('Administrator'));

  const problems: string[] = [];
  const g = checkGenieRole(fromBits(genieRole.permissions), genieAdmin);
  if (!g.ok) problems.push(`genie_permissions_mismatch: missing [${g.missing}] extra [${g.extra}] administrator=${g.administrator}`);
  const leftovers = roles.filter((r) => r.name.startsWith('spike-'));
  if (leftovers.length > 0) warn(`warning: ${leftovers.length} leftover spike- role(s); run \`pnpm spike cleanup --orphans\``);
  const order = checkRoleOrder({
    arranger: await top(ids.arranger),
    arrangerAdmin,
    genie: genieRole.position,
    spikeRoles: [],
    probes: [await top(ids.probeA), await top(ids.probeB)],
  });
  problems.push(...order.problems);

  for (const l of await readLedgers(OUT_DIR)) {
    if (l.kept && (hasUnrestored(l, 'everyone') || hasUnrestored(l, 'genieRole'))) {
      warn(`warning: kept ledger ${l.runId} holds an unrestored snapshot; run \`pnpm spike cleanup --run ${l.runId}\` when done`);
    }
  }
  if (printInvite) {
    log(
      `genie invite URL: https://discord.com/oauth2/authorize?client_id=${printInvite}&scope=bot%20applications.commands&permissions=${toBits([...INVITE_PERMISSIONS])}`,
    );
  }
  if (problems.length > 0) throw new ExitError(3, `preflight refused:\n  ${problems.join('\n  ')}`);
  return { genieRolePermissions: fromBits(genieRole.permissions) };
}

async function loginGenie(token: string): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  await client.login(token);
  await new Promise<void>((resolve) => (client.isReady() ? resolve() : client.once('clientReady', () => resolve())));
  return client;
}

async function snapshotEveryone(b: Bots, guildId: string, ledger: LedgerHandle) {
  if (!canSnapshot(await readLedgers(OUT_DIR), 'everyone')) {
    throw new ExitError(8, 'unrestored_snapshot: a ledger still holds an unrestored @everyone snapshot; run cleanup --run <id> first');
  }
  const everyone = await b.arranger.must<Role>('get', `/guilds/${guildId}/roles/${guildId}`);
  await recordSnapshot(ledger, 'everyone', everyone.permissions);
}

async function endOfRun(b: Bots, guildId: string, ids: Ids, ledger: LedgerHandle) {
  const ledgers = await readLedgers(OUT_DIR);
  const plan = planCleanup({ kind: 'end-of-run', runId: ledger.data.runId }, ledgers, { channels: [], roles: [] });
  const result = await applyCleanup(plan, new CleanupAdapter(b.arranger, guildId, ids.genie));
  if (plan.restoreEveryone !== undefined) await markRestored(ledger, 'everyone');
  if (plan.restoreGenieRole !== undefined) await markRestored(ledger, 'genieRole');
  if (!result.ok) warn(`cleanup left ${result.failed.length} resource(s); run \`pnpm spike cleanup --run ${ledger.data.runId}\``);
}

function ports(b: Bots, guildId: string, ids: Ids, ledger: LedgerHandle, client: Client, subjectApi: Api): RunnerPorts {
  return {
    arrange: new ArrangeAdapter(b.arranger, guildId, ledger, ids.genie),
    write: new WriteAdapter(b.genie, b.arranger, client, guildId, ledger),
    act: new ActAdapter(subjectApi, ledger),
    threadState: new ThreadStateAdapter(b.arranger),
  };
}

export async function s3Preflight(c: Config) {
  const b = bots(c);
  await guarded(b.arranger, c.GENIE_SPIKE_GUILD_ID!);
  await preflight(b, c.GENIE_SPIKE_GUILD_ID!, await identities(b), c.GENIE_SPIKE_GENIE_CLIENT_ID);
  log('preflight ok');
}

export async function s3Record(c: Config, opts: { acceptChanges: boolean; keep: boolean }) {
  const guildId = c.GENIE_SPIKE_GUILD_ID!;
  const b = bots(c);
  await guarded(b.arranger, guildId);
  const ids = await identities(b);
  const catalog = buildCatalog();
  const client = await loginGenie(c.GENIE_SPIKE_GENIE_TOKEN!);
  const passes: PassResult[] = [];
  try {
    for (let n = 1; n <= 2; n++) {
      const { genieRolePermissions } = await preflight(b, guildId, ids);
      const ledger = await createLedger(OUT_DIR, { runId: newRun(), guildId, kept: opts.keep });
      try {
        await snapshotEveryone(b, guildId, ledger);
        const ctx: RunContext = { guildId, runId: ledger.data.runId, members: { subject: ids.probeA, other: ids.probeB, genie: ids.genie }, genieRolePermissions };
        log(`pass ${n} (${ledger.data.runId}): ${catalog.length} cases`);
        const pass = await runPass(catalog, ports(b, guildId, ids, ledger, client, b.probeA), ctx, ledger.data.runId);
        passes.push(pass);
        if (pass.stop) {
          throw new ExitError(7, `profile_unwritable: ${pass.stop.caseIds.join(', ')}\n${JSON.stringify(pass.writes, null, 2)}`);
        }
        for (const id of pass.amendmentRequired) warn(`create path unwritable (${id}): an FR-33 amendment to §6.3 is required`);
      } finally {
        await endOfRun(b, guildId, ids, ledger);
      }
    }
  } finally {
    await writeFile(join(OUT_DIR, `s3-passes-${passes[0]?.passId ?? 'none'}.json`), `${JSON.stringify(passes, null, 2)}\n`);
    await client.destroy();
  }

  const [a, bPass] = passes as [PassResult, PassResult];
  const stability = checkStability(a, bPass);
  if (!stability.stable) {
    const detail = stability.caseIds
      .map((id) => {
        const failed = [...a.cases, ...bPass.cases].find((x) => x.caseId === id && x.status !== 'ok');
        return `  ${id}${failed?.failure ? `: ${failed.failure}` : ''}`;
      })
      .join('\n');
    throw new ExitError(4, `unstable or inconclusive; no fixture written:\n${detail}`);
  }

  const { genieRolePermissions } = await preflight(b, guildId, ids);
  const fixture = buildFixture(catalog, bPass, {
    recordedAt: new Date().toISOString(),
    discordJs: DISCORD_JS,
    apiVersion: '10',
    passIds: [a.passId, bPass.passId],
    genieRolePermissions,
  });
  const existing = await readFile(FIXTURE, 'utf8').catch(() => undefined);
  const changed = changedCases(existing, fixture);
  if (changed.length > 0 && !opts.acceptChanges) {
    throw new ExitError(5, `the recorded cases differ from ${FIXTURE}; re-run with --accept-changes to replace:\n  ${changed.join('\n  ')}`);
  }
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(FIXTURE, serializeFixture(fixture));
  await writeFile(SCHEMA, fixtureJsonSchema());

  const disagreements = libraryDisagreements(bPass.cases, catalog);
  log(`wrote ${FIXTURE} (${fixture.cases.length} cases)`);
  log(`library vs observed disagreements: ${disagreements.length}`);
  for (const d of disagreements) log(`  ${d.caseId}: ${d.permission}`);
  for (const id of bPass.amendmentRequired) log(`amendment required: ${id}`);
}

export async function s3Stage(c: Config, caseId: string, subjectUserId: string) {
  const guildId = c.GENIE_SPIKE_GUILD_ID!;
  const b = bots(c);
  const guild = await guarded(b.arranger, guildId);
  const ids = await identities(b);
  let plan;
  try {
    plan = stagePlan(caseId, subjectUserId);
  } catch (e) {
    throw new ExitError(6, (e as Error).message);
  }
  const { genieRolePermissions } = await preflight(b, guildId, ids);

  const roles = await b.arranger.must<Role[]>('get', `/guilds/${guildId}/roles`);
  const subject = await b.arranger.must<{ roles: string[]; user: { bot?: boolean } }>('get', `/guilds/${guildId}/members/${subjectUserId}`);
  const eligible = stageEligibility({
    isOwner: guild.owner_id === subjectUserId,
    hasAdministrator: roles.filter((r) => subject.roles.includes(r.id)).some((r) => fromBits(r.permissions).includes('Administrator')),
    isBot: Boolean(subject.user.bot) || Object.values(ids).includes(subjectUserId),
  });
  if (!eligible.ok) throw new ExitError(3, `stage refused: ${eligible.reason}`);

  const ledger = await createLedger(OUT_DIR, { runId: newRun(), guildId, kept: true });
  await snapshotEveryone(b, guildId, ledger);
  const client = await loginGenie(c.GENIE_SPIKE_GENIE_TOKEN!);
  try {
    const ctx: RunContext = { guildId, runId: ledger.data.runId, members: { subject: subjectUserId, other: ids.probeB, genie: ids.genie }, genieRolePermissions };
    const prepared = await prepareCase(plan.caseDef, ports(b, guildId, ids, ledger, client, b.probeA), ctx);
    if (!prepared.ok) throw new ExitError(4, `stage failed: ${prepared.result.failure}`);
    log(`staged ${caseId} as run ${ledger.data.runId} (kept; @everyone left at the case's base)`);
    log(`target: https://discord.com/channels/${guildId}/${prepared.targetId}`);
    log(`try, in order: ${plan.actions.join(', ')}  (react to the existing 👍 first, then with a new emoji)`);
    log(`when done: pnpm spike cleanup --run ${ledger.data.runId}`);
  } finally {
    await client.destroy();
  }
}

export async function cleanupCommand(c: Config, scope: { run?: string; orphans?: boolean; all?: boolean }) {
  const guildId = c.GENIE_SPIKE_GUILD_ID!;
  const arranger = new Api(c.GENIE_SPIKE_ARRANGER_TOKEN!);
  await guarded(arranger, guildId);
  const genie = await whoAmI(new Api(c.GENIE_SPIKE_GENIE_TOKEN!));
  const ledgers = await readLedgers(OUT_DIR);
  const channels = await arranger.must<{ id: string; name: string; type: number }[]>('get', `/guilds/${guildId}/channels`);
  const roles = await arranger.must<Role[]>('get', `/guilds/${guildId}/roles`);
  const active = await arranger.must<{ threads: { id: string; name: string }[] }>('get', `/guilds/${guildId}/threads/active`);
  const snapshot = {
    channels: [
      ...channels.map((ch) => ({ id: ch.id, name: ch.name, kind: ch.type === 4 ? ('category' as const) : ('channel' as const) })),
      ...active.threads.map((t) => ({ id: t.id, name: t.name, kind: 'thread' as const })),
    ],
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
  };
  const s = scope.run ? { kind: 'run' as const, runId: scope.run } : scope.all ? { kind: 'all' as const } : { kind: 'orphans' as const };
  const plan = planCleanup(s, ledgers, snapshot);
  const result = await applyCleanup(plan, new CleanupAdapter(arranger, guildId, genie.id));
  for (const l of ledgers) {
    const handle = { path: join(OUT_DIR, `ledger-${l.runId}.json`), data: l };
    if (scope.run && l.runId !== scope.run) continue;
    if (!scope.run && !scope.all) continue;
    if (plan.restoreEveryone !== undefined && hasUnrestored(l, 'everyone')) await markRestored(handle, 'everyone');
    if (plan.restoreGenieRole !== undefined && hasUnrestored(l, 'genieRole')) await markRestored(handle, 'genieRole');
  }
  log(`deleted ${result.deleted.length}, already gone ${result.alreadyGone.length}, failed ${result.failed.length}`);
  if (!result.ok) throw new ExitError(1, `cleanup failed for: ${result.failed.map((f) => `${f.id} (${f.status}${f.code ? `/${f.code}` : ''})`).join(', ')}`);
}

export { genieRoleId };
