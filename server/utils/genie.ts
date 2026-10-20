import { randomUUID } from 'node:crypto';
import {
  type StringVault,
  createFixedWindowLimiter,
  createVault,
  generateSetupCode,
  parseTrustedProxies,
  setupCodeMatches,
  stringVault,
  systemClock,
} from '@towerism/selfhost-kit';
import { dirname, join, resolve } from 'node:path';
import { createCloseoutHandlers } from '../bot/closeout-handlers';
import { BOT_COMMANDS, createBotHandlers } from '../bot/handlers';
import { PENALTY_COMMANDS, createPenaltyHandlers } from '../bot/penalty-handlers';
import { createAttendanceHttp } from '../modules/attendance/adapters/http';
import { createAttendanceMessagesHttp } from '../modules/attendance/adapters/http/messages';
import { createMessageDeliveryService, systemDelayScheduler } from '../modules/message-delivery';
import { createAttendanceImportService } from '../modules/attendance-import';
import { createCloseoutService } from '../modules/closeout';
import { createAttachmentFetcher } from '../modules/closeout/adapters/cdn';
import { createAttendanceConnectionService } from '../modules/setup/attendance-connection';
import { createInteractionRouter } from '../bot/router';
import { type DirectoryService, createDirectoryService } from '../modules/directory';
import { type EventDaysService, createEventDaysService } from '../modules/event-days';
import { createPenaltiesService } from '../modules/penalties';
import { createProvisioningService } from '../modules/provisioning';
import { createBotRunner, systemBotScheduler } from '../modules/discord/bot-runner';
import { createDiscordJs } from '../modules/discord/adapters/discordjs';
import type { CreateDiscord } from '../modules/discord/port';
import { createJobs } from '../modules/jobs/jobs';
import { createSqliteJobStore } from '../modules/jobs/sqlite-store';
import { createLoginService } from '../modules/setup/login';
import { createSetupService } from '../modules/setup/service';
import { createSettingsService } from '../modules/setup/settings';
import { createSetupStore } from '../modules/setup/store';

/**
 * Genie's wiring: one instance of each service per process, built on first use from the runtime config.
 * Modules get their dependencies here and never reach for Nitro themselves.
 */

/** Identifies this process: a wizard unlocked before a restart is locked again (the code changed too). */
export const bootId = randomUUID();
let setupCode: string | null = null;

const once = <T>(build: () => T) => {
  let value: T | undefined;
  return () => (value ??= build());
};

export const useVault = once((): StringVault => stringVault(createVault({ key: useRuntimeConfig().vaultKey, label: 'vault' })));

export const useCreateDiscord = once(
  (): CreateDiscord => createDiscordJs({ apiUrl: useRuntimeConfig().discord.apiUrl, logger: useLogger('discord') }),
);

const useStore = once(() => createSetupStore(useDatabase().db));

export const useSetup = once(() =>
  createSetupService({
    store: useStore(),
    vault: useVault(),
    createDiscord: useCreateDiscord(),
    clock: systemClock,
    logger: useLogger('setup'),
    onComplete: () => {
      setupCode = null;
      void useBot().start();
    },
  }),
);

export const useLogin = once(() =>
  createLoginService({
    store: useStore(),
    setup: useSetup(),
    createDiscord: useCreateDiscord(),
    clock: systemClock,
    logger: useLogger('login'),
    dayHeadJudge: (userId, holdsHeadJudgeRole) => useEventDays().dayHeadJudge(userId, holdsHeadJudgeRole),
  }),
);

export const useSettings = once(() =>
  createSettingsService({ store: useStore(), setup: useSetup(), createDiscord: useCreateDiscord(), clock: systemClock, logger: useLogger('settings') }),
);

/** The guild this install serves, once setup bound it (§5.1). */
export const useBoundGuildId = (): string | null => useStore().binding()?.guildId ?? null;

/**
 * The store's zone (`TZ`, §5.1): days are its calendar dates. In production the launcher has already defaulted
 * and checked `TZ` (`prepareGenieEnv`); the fallback only serves `nuxt dev`.
 */
const storeTimeZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Discord through the stored bot token (the port caches one REST client per token). */
const useGateway = () => useCreateDiscord()(useSetup().botToken()).gateway;

// The directory and event-days refer to each other through injected hooks, so the modules stay one-way.
export const useDirectory = once((): DirectoryService =>
  createDirectoryService({
    db: useDatabase().db,
    clock: systemClock,
    logger: useLogger('directory'),
    onLinkChanged: (id): number[] => useEventDays().onLinkChanged(id),
    isReferenced: (id): boolean => useEventDays().isReferenced(id) || usePenalties().namesJudge(id),
  }),
);

export const useEventDays = once((): EventDaysService =>
  createEventDaysService({
    db: useDatabase().db,
    clock: systemClock,
    logger: useLogger('event-days'),
    timeZone: storeTimeZone(),
    guildId: () => useStore().binding()?.guildId ?? null,
    directory: useDirectory(),
    enqueueSync: (dayId) => useJobs().enqueueUnlessQueued({ kind: 'sync', dayId }).jobId,
    currentSeason: () => useStore().currentSeason(),
  }),
);

export const useAttendanceConnection = once(() =>
  createAttendanceConnectionService({
    store: useStore(),
    vault: useVault(),
    clock: systemClock,
    logger: useLogger('attendance'),
    onConnectionChanged: (change) => useMessageDelivery().connectionChanged(change),
  }),
);

/** Attendance's Discord messages, sent as DMs through the bot while it is connected (ADR-0017). */
export const useMessageDelivery = once(() =>
  createMessageDeliveryService({
    db: useDatabase().db,
    clock: systemClock,
    logger: useLogger('message-delivery'),
    scheduler: systemDelayScheduler,
    directory: useDirectory(),
    ready: () => useSetup().isComplete(),
    connection: () => useAttendanceConnection().connection(),
    messages: (connection) => createAttendanceMessagesHttp({ ...connection, maxBytes: 256 * 1024 }),
    gateway: useGateway,
    bot: { isConnected: () => useBot().isConnected(), onStateChange: (listener) => useBot().onStateChange(listener) },
  }),
);

/** Attendance through the stored connection; the adapter is built per pull, so a saved connection applies at once. */
export const useAttendanceImport = once(() =>
  createAttendanceImportService({
    db: useDatabase().db,
    clock: systemClock,
    logger: useLogger('attendance-import'),
    timeZone: storeTimeZone(),
    eventDays: useEventDays(),
    directory: useDirectory(),
    source: () => {
      const connection = useAttendanceConnection().connection();
      if (!connection) return null;
      const { timeoutMs, maxBytes } = useRuntimeConfig().attendance;
      return createAttendanceHttp({ ...connection, timeoutMs: Number(timeoutMs), maxBytes: Number(maxBytes) });
    },
  }),
);

export const useProvisioning = once(() =>
  createProvisioningService({
    db: useDatabase().db,
    clock: systemClock,
    logger: useLogger('provisioning'),
    eventDays: useEventDays(),
    jobs: useJobs(),
    gateway: useGateway,
    binding: () => {
      const b = useStore().binding();
      return b ? { guildId: b.guildId, organizerRoleId: b.organizerRoleId, headJudgeRoleId: b.headJudgeRoleId } : null;
    },
  }),
);

export const usePenalties = once(() =>
  createPenaltiesService({
    db: useDatabase().db,
    clock: systemClock,
    logger: useLogger('penalties'),
    eventDays: useEventDays(),
    directory: useDirectory(),
    provisioning: useProvisioning(),
    gateway: useGateway,
    season: { current: () => useStore().currentSeason(), put: (season, now) => useStore().putCurrentSeason(season, now) },
  }),
);

/** The exports folder: configured, or `exports` beside the database (§5.2). */
export const exportsDir = (): string => {
  const config = useRuntimeConfig();
  return resolve(config.exportsDir || join(dirname(resolve(config.databasePath)), 'exports'));
};

export const useCloseout = once(() => {
  const config = useRuntimeConfig();
  const store = useStore();
  return createCloseoutService({
    db: useDatabase().db,
    clock: systemClock,
    logger: useLogger('closeout'),
    eventDays: useEventDays(),
    provisioning: useProvisioning(),
    penalties: usePenalties(),
    jobs: useJobs(),
    gateway: useGateway,
    binding: () => {
      const b = store.binding();
      return b ? { guildId: b.guildId, organizerRoleId: b.organizerRoleId, headJudgeRoleId: b.headJudgeRoleId } : null;
    },
    exportsDir: exportsDir(),
    graceMs: Number(config.purgeGraceMs),
    settings: { get: () => store.closeOutSettings(), put: (s, now) => store.putCloseOutSettings(s, now) },
    fetcher: createAttachmentFetcher({
      hosts: String(config.discord.cdnHosts)
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
      allowHttp: String(config.discord.cdnAllowHttp) === 'true',
      timeoutMs: 60_000,
    }),
  });
});

/** What the bot needs to tell organizers from everyone else (§9). */
const botAccess = () => {
  const b = useStore().binding();
  return {
    ownerId: useStore().install()?.ownerDiscordUserId ?? null,
    organizerRoleId: b?.organizerRoleId ?? null,
    headJudgeRoleId: b?.headJudgeRoleId ?? null,
    allowlist: { enabled: b?.organizerAllowlistEnabled ?? false, userIds: useStore().allowlist() },
  };
};

const useBotHandlers = once(() =>
  createBotHandlers({
    directory: useDirectory(),
    provisioning: useProvisioning(),
    access: botAccess,
    linkLimiter: createFixedWindowLimiter({ max: 5, windowMs: 10 * 60_000 }),
    logger: useLogger('bot'),
  }),
);

const usePenaltyHandlers = once(() =>
  createPenaltyHandlers({
    penalties: usePenalties(),
    provisioning: useProvisioning(),
    eventDays: useEventDays(),
    directory: useDirectory(),
    access: botAccess,
    clock: systemClock,
  }),
);

const useCloseoutHandlers = once(() =>
  createCloseoutHandlers({ closeout: useCloseout(), provisioning: useProvisioning(), eventDays: useEventDays(), access: botAccess, logger: useLogger('bot') }),
);

const useRouter = once(() => {
  const handlers = useBotHandlers();
  const penalties = usePenaltyHandlers();
  const closeout = useCloseoutHandlers();
  return createInteractionRouter({
    boundGuildId: () => useStore().binding()?.guildId ?? null,
    logger: useLogger('bot'),
    commands: { ...handlers.commands, ...penalties.commands },
    components: { ...handlers.components, ...penalties.components, ...closeout.components },
    modals: penalties.modals,
    autocomplete: penalties.autocomplete,
  });
});

export const useBot = once(() =>
  createBotRunner({
    createDiscord: useCreateDiscord(),
    loadToken: () => useSetup().botToken(),
    guildId: () => useStore().binding()?.guildId ?? null,
    commands: [...BOT_COMMANDS, ...PENALTY_COMMANDS],
    onInteraction: (interaction, reply) => useRouter().route(interaction, reply),
    scheduler: systemBotScheduler,
    logger: useLogger('bot'),
  }),
);

export const useJobs = once(() =>
  createJobs({
    store: createSqliteJobStore(useDatabase().db),
    clock: systemClock,
    logger: useLogger('jobs'),
    redactor,
    autoRun: true,
  }),
);

export const useTrustedProxies = once(() => parseTrustedProxies(String(useRuntimeConfig().trustedProxies ?? '')));

export const useAuthLimiters = once(() => {
  const { login, setup } = useRuntimeConfig().authRateLimit;
  // A login is one start and one callback: each has its own bucket with the login limits.
  return { login: createFixedWindowLimiter(login), callback: createFixedWindowLimiter(login), setup: createFixedWindowLimiter(setup) };
});

/** Prints the one-time setup code while setup is incomplete (architecture §6.1). */
export function announceSetupCode(): void {
  if (useSetup().isComplete()) return;
  setupCode = generateSetupCode();
  useLogger('setup').info(`Setup isn't finished. Open /setup and enter this setup code: ${setupCode}`);
}

export function setupCodeAccepted(given: string): boolean {
  return setupCode !== null && !useSetup().isComplete() && setupCodeMatches(setupCode, given);
}
