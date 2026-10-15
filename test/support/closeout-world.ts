import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY_MS } from '../../shared/closeout';
import { type CloseoutService, createCloseoutService } from '../../server/modules/closeout';
import { createAttachmentFetcher } from '../../server/modules/closeout/adapters/cdn';
import type { DiscordGateway } from '../../server/modules/discord/port';
import { createSetupStore } from '../../server/modules/setup/store';
import { BOT_TOKEN, IDS } from './discord-world';
import { type FakeCdnHttp, startFakeCdnHttp } from './fake-cdn-http';
import { type LogRecord, recordingLogger } from './logger';
import { type PenaltyWorld, penaltyWorld } from './penalty-world';
import { PEOPLE } from './provisioning-world';

export const GRACE_MS = 7 * DAY_MS;

export interface CloseoutWorld extends PenaltyWorld {
  closeout: CloseoutService;
  exportsDir: string;
  cdn: FakeCdnHttp;
  logs: LogRecord[];
  botUserId: string;
  /** Closes the day as Brock (the Cup head judge) and runs the lock and the export. */
  closeAndExport(): Promise<void>;
  /** Every job of a kind for the day, oldest first. */
  jobsOf(kind: string): { id: number; state: string; error: string | null; dueAt: number | null }[];
  /** Runs everything due now, until nothing is left to run. */
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The penalty world's open, provisioned day (Cup with a Tournament ID, Cup VGC without), with close-out wired to a
 * temporary exports folder, the fake clock and the real attachment fetcher against a local HTTP CDN.
 */
export async function closeoutWorld(
  opts: { graceMs?: number; wrap?: (gateway: DiscordGateway) => DiscordGateway; beforeCsvWrite?: (eventId: number) => Promise<void> } = {},
): Promise<CloseoutWorld> {
  const w = await penaltyWorld();
  w.discord.setNow(() => w.clock.now());
  const cdn = await startFakeCdnHttp(w.discord);
  const exportsDir = mkdtempSync(join(tmpdir(), 'genie-exports-'));
  const store = createSetupStore(w.database.db);
  const logger = recordingLogger('closeout');
  const closeout = createCloseoutService({
    db: w.database.db,
    clock: w.clock,
    logger,
    eventDays: w.days,
    provisioning: w.provisioning,
    penalties: w.penalties,
    jobs: w.jobs,
    gateway: () => (opts.wrap ?? ((g) => g))(w.discord.create(BOT_TOKEN).gateway),
    binding: () => ({ guildId: IDS.guild, organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole }),
    exportsDir,
    graceMs: opts.graceMs ?? GRACE_MS,
    settings: { get: () => store.closeOutSettings(), put: (s, now) => store.putCloseOutSettings(s, now) },
    fetcher: createAttachmentFetcher({ hosts: [cdn.host], allowHttp: true, timeoutMs: 300 }),
    ...(opts.beforeCsvWrite ? { testHooks: { beforeCsvWrite: opts.beforeCsvWrite } } : {}),
  });
  closeout.register();

  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      const before = w.database.sqlite.prepare("SELECT count(*) FROM job WHERE state = 'queued' AND (due_at IS NULL OR due_at <= ?)").pluck().get(w.clock.now()) as number;
      if (!before) return;
      await w.jobs.runDue();
      await w.jobs.idle();
    }
    throw new Error('jobs kept queueing');
  };

  return {
    ...w,
    closeout,
    exportsDir,
    cdn,
    logs: logger.records,
    botUserId: w.discord.applications.get(IDS.app)!.botUserId,
    async closeAndExport() {
      await closeout.close(w.dayId, PEOPLE.brock);
      await settle();
    },
    jobsOf: (kind) =>
      w.database.sqlite
        .prepare('SELECT id, state, error, due_at AS dueAt FROM job WHERE day_id = ? AND kind = ? ORDER BY id')
        .all(w.dayId, kind) as { id: number; state: string; error: string | null; dueAt: number | null }[],
    settle,
    async dispose() {
      await cdn.close();
      rmSync(exportsDir, { recursive: true, force: true });
      w.close();
    },
  };
}
