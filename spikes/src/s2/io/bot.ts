import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, GatewayIntentBits, MessageFlags, type Interaction } from 'discord.js';
import { ExitError, OUT_DIR, guarded, log, runId as newRun, warn } from '../../io/session.js';
import { Api } from '../../io/rest.js';
import { createLedger, createTracked } from '../../shared/ledger.js';
import type { Config } from '../../shared/config.js';
import { commands, modalFor, parseSubmission, startMessage, type Variant } from '../forms.js';
import { RunTracker, summarize, type S2Outcome, type S2Run } from '../timing.js';

const RUNS = join(OUT_DIR, 's2-runs.jsonl');
const record = (r: S2Run) => appendFile(RUNS, `${JSON.stringify(r)}\n`);

/** The device label is fixed for the session, outside every timed window. */
export async function s2Bot(c: Config, opts: { device: string }) {
  const guildId = c.GENIE_SPIKE_GUILD_ID!;
  const api = new Api(c.GENIE_SPIKE_GENIE_TOKEN!);
  await guarded(api, guildId);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const tracker = new RunTracker(opts.device);
  const ledger = await createLedger(OUT_DIR, { runId: newRun(), guildId, kept: false });

  client.on('interactionCreate', async (i: Interaction) => {
    try {
      if (i.guildId !== guildId) return;
      if (i.isButton() && i.customId.startsWith('s2:start:')) {
        const variant = i.customId.slice(-1) as Variant;
        const replaced = tracker.start({ variant, userId: i.user.id, id: i.id });
        if (replaced) await record(replaced);
        await i.reply({ content: `Timing started. Now run \`/spike-penalty-${variant.toLowerCase()}\`.`, flags: MessageFlags.Ephemeral });
      } else if (i.isChatInputCommand() && i.commandName.startsWith('spike-penalty-')) {
        const variant = i.commandName.endsWith('-a') ? 'A' : 'B';
        tracker.command({ variant, userId: i.user.id, id: i.id });
        await i.showModal(modalFor(variant, `s2:modal:${variant}`));
      } else if (i.isModalSubmit() && i.customId.startsWith('s2:modal:')) {
        const variant = i.customId.slice(-1) as Variant;
        const parsed = parseSubmission({ playerId: i.fields.getTextInputValue('playerId'), notes: i.fields.getTextInputValue('notes') });
        const outcome: Exclude<S2Outcome, 'abandoned'> = parsed.ok ? 'ok' : parsed.outcome;
        const run = tracker.submit({ variant, userId: i.user.id, id: i.id, outcome });
        if (run) await record(run);
        await i.reply({
          content: parsed.ok
            ? `Recorded${run?.durationMs !== undefined ? ` in ${(run.durationMs / 1000).toFixed(1)} s` : ' (no Start pressed, not timed)'}.`
            : 'Player ID must be digits only.',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (e) {
      warn(`interaction failed: ${(e as Error).message}`);
    }
  });

  await client.login(c.GENIE_SPIKE_GENIE_TOKEN!);
  await new Promise<void>((resolve) => client.once('clientReady', () => resolve()));
  const appId = client.application!.id;
  await api.must('put', `/applications/${appId}/guilds/${guildId}/commands`, { body: commands() });

  const channelId = await createTracked(ledger, { kind: 'channel', name: `spike-${ledger.data.runId}-s2` }, async () =>
    (await api.must<{ id: string }>('post', `/guilds/${guildId}/channels`, { body: { name: `spike-${ledger.data.runId}-s2`, type: 0 } })).id,
  );
  await api.must('post', `/channels/${channelId}/messages`, { body: startMessage(opts.device) });
  log(`S2 bot ready on device "${opts.device}": open #spike-${ledger.data.runId}-s2. Ctrl-C to stop.`);

  const timer = setInterval(() => void Promise.all(tracker.expire(Date.now()).map(record)), 30_000);
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  clearInterval(timer);
  for (const r of tracker.close()) await record(r);
  // The two guild commands go away with the bot; the channel goes with `cleanup --run`.
  await api.call('put', `/applications/${appId}/guilds/${guildId}/commands`, { body: [] });
  await api.call('delete', `/channels/${channelId}`);
  await client.destroy();
  log('S2 bot stopped; commands removed.');
}

export async function s2Summarize() {
  const raw = await readFile(RUNS, 'utf8').catch(() => '');
  const runs = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as S2Run);
  const rows = summarize(runs);
  if (rows.length === 0) throw new ExitError(1, `no runs recorded in ${RUNS}`);
  const s = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
  log('variant  device               runs  errors  abandoned  median   max');
  for (const r of rows) {
    log(`${r.variant.padEnd(8)} ${r.device.padEnd(20)} ${String(r.runs).padStart(4)}  ${String(r.errors).padStart(6)}  ${String(r.abandoned).padStart(9)}  ${s(r.medianMs).padStart(7)}  ${s(r.maxMs).padStart(6)}`);
  }
}

/** A run that never reached the bot (e.g. the client can't show Variant B's modal). */
export async function s2Note(opts: { variant: Variant; device: string; outcome: S2Outcome; note?: string }) {
  await record({ variant: opts.variant, device: opts.device, startId: 'manual', outcome: opts.outcome, ...(opts.note ? { note: opts.note } : {}) });
  log(`noted ${opts.variant} ${opts.outcome}`);
}
