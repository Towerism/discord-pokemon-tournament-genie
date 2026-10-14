import { parseArgs } from 'node:util';
import { ExitError, log, startSession, warn } from './io/session.js';
import type { ConfigKey } from './shared/config.js';

const USAGE = `pnpm spike <command> — M0 spike harnesses (see docs/spikes/README.md)

  cleanup --run <runId> | --orphans | --all
  s1 serve --redirect <uri> [--host 127.0.0.1] [--port 3001] [--insecure-cookie]
  s1 note --redirect <uri> --outcome <outcome> [--insecure-cookie] [--detail <text>]
  s2 bot --device <label>
  s2 summarize
  s2 note --variant A|B --device <label> --outcome <outcome> [--note <text>]
  s3 preflight
  s3 record [--accept-changes] [--keep]
  s3 stage --case <id> --subject-user <userId>
  s4 seed [--channels 4] [--messages 2000] [--no-keep]
  s4 measure [--content-probe]
  s4 check-expired [<seed file>]`;

const BOTS: ConfigKey[] = [
  'GENIE_SPIKE_GUILD_ID',
  'GENIE_SPIKE_ARRANGER_TOKEN',
  'GENIE_SPIKE_GENIE_TOKEN',
  'GENIE_SPIKE_PROBE_A_TOKEN',
  'GENIE_SPIKE_PROBE_B_TOKEN',
];

async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      run: { type: 'string' },
      orphans: { type: 'boolean' },
      all: { type: 'boolean' },
      redirect: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '3001' },
      'insecure-cookie': { type: 'boolean' },
      outcome: { type: 'string' },
      detail: { type: 'string' },
      device: { type: 'string' },
      variant: { type: 'string' },
      note: { type: 'string' },
      'accept-changes': { type: 'boolean' },
      keep: { type: 'boolean' },
      case: { type: 'string' },
      'subject-user': { type: 'string' },
      channels: { type: 'string', default: '4' },
      messages: { type: 'string', default: '2000' },
      'no-keep': { type: 'boolean' },
      'content-probe': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [area, cmd, arg] = positionals;
  const need = (x: string | undefined, flag: string) => {
    if (!x) throw new ExitError(1, `missing --${flag}\n\n${USAGE}`);
    return x;
  };
  const cookieMode = v['insecure-cookie'] ? ('insecure' as const) : ('secure' as const);

  if (v.help || !area) {
    log(USAGE);
    return;
  }
  if (area === 'cleanup') {
    if ([v.run, v.orphans, v.all].filter(Boolean).length !== 1) throw new ExitError(1, `cleanup needs exactly one of --run, --orphans, --all\n\n${USAGE}`);
    const c = await startSession(['GENIE_SPIKE_GUILD_ID', 'GENIE_SPIKE_ARRANGER_TOKEN', 'GENIE_SPIKE_GENIE_TOKEN']);
    const { cleanupCommand } = await import('./s3/io/commands.js');
    return cleanupCommand(c, { ...(v.run ? { run: v.run } : {}), orphans: Boolean(v.orphans), all: Boolean(v.all) });
  }
  if (area === 's1') {
    const { s1Serve, s1Note } = await import('./s1/io/server.js');
    if (cmd === 'serve') {
      const c = await startSession(['GENIE_SPIKE_GENIE_CLIENT_ID', 'GENIE_SPIKE_GENIE_CLIENT_SECRET']);
      return s1Serve(c, { redirect: need(v.redirect, 'redirect'), host: v.host!, port: Number(v.port), cookieMode });
    }
    if (cmd === 'note') {
      await startSession([]);
      return s1Note({ redirect: need(v.redirect, 'redirect'), outcome: need(v.outcome, 'outcome') as never, cookieMode, ...(v.detail ? { detail: v.detail } : {}) });
    }
  }
  if (area === 's2') {
    const { s2Bot, s2Summarize, s2Note } = await import('./s2/io/bot.js');
    if (cmd === 'bot') return s2Bot(await startSession(['GENIE_SPIKE_GUILD_ID', 'GENIE_SPIKE_GENIE_TOKEN']), { device: need(v.device, 'device') });
    if (cmd === 'summarize') {
      await startSession([]);
      return s2Summarize();
    }
    if (cmd === 'note') {
      await startSession([]);
      const variant = need(v.variant, 'variant');
      if (variant !== 'A' && variant !== 'B') throw new ExitError(1, '--variant must be A or B');
      return s2Note({ variant, device: need(v.device, 'device'), outcome: need(v.outcome, 'outcome') as never, ...(v.note ? { note: v.note } : {}) });
    }
  }
  if (area === 's3') {
    const s3 = await import('./s3/io/commands.js');
    if (cmd === 'preflight') return s3.s3Preflight(await startSession([...BOTS, 'GENIE_SPIKE_GENIE_CLIENT_ID']));
    if (cmd === 'record') return s3.s3Record(await startSession(BOTS), { acceptChanges: Boolean(v['accept-changes']), keep: Boolean(v.keep) });
    if (cmd === 'stage') return s3.s3Stage(await startSession(BOTS), need(v.case, 'case'), need(v['subject-user'], 'subject-user'));
  }
  if (area === 's4') {
    const s4 = await import('./s4/io/commands.js');
    if (cmd === 'seed') {
      return s4.s4Seed(await startSession(BOTS), { channels: Number(v.channels), messages: Number(v.messages), keep: !v['no-keep'] });
    }
    if (cmd === 'measure') return s4.s4Measure(await startSession(BOTS), { contentProbe: Boolean(v['content-probe']) });
    if (cmd === 'check-expired') return s4.s4CheckExpired(await startSession(['GENIE_SPIKE_GUILD_ID', 'GENIE_SPIKE_GENIE_TOKEN']), arg);
  }
  throw new ExitError(1, `unknown command: ${positionals.join(' ')}\n\n${USAGE}`);
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (e: unknown) => {
    if (e instanceof ExitError) {
      warn(e.message);
      process.exit(e.exitCode);
    }
    warn(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  },
);
