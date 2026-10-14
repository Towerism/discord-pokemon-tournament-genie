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
import { BOT_COMMANDS, createBotHandlers } from '../bot/handlers';
import { createInteractionRouter } from '../bot/router';
import { type DirectoryService, createDirectoryService } from '../modules/directory';
import { type EventDaysService, createEventDaysService } from '../modules/event-days';
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

/** The store's zone (`TZ`, §5.1): days are its calendar dates. */
const storeTimeZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Discord through the stored bot token (the port caches one REST client per token). */
const useGateway = () => useCreateDiscord()(useSetup().botToken()).gateway;

// The directory and event-days refer to each other through injected hooks, so the modules stay one-way (FR-13).
export const useDirectory = once((): DirectoryService =>
  createDirectoryService({
    db: useDatabase().db,
    clock: systemClock,
    logger: useLogger('directory'),
    onLinkChanged: (id): number[] => useEventDays().onLinkChanged(id),
    isReferenced: (id): boolean => useEventDays().isReferenced(id),
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

const useBotHandlers = once(() =>
  createBotHandlers({
    directory: useDirectory(),
    provisioning: useProvisioning(),
    access: () => {
      const b = useStore().binding();
      return {
        ownerId: useStore().install()?.ownerDiscordUserId ?? null,
        organizerRoleId: b?.organizerRoleId ?? null,
        headJudgeRoleId: b?.headJudgeRoleId ?? null,
        allowlist: { enabled: b?.organizerAllowlistEnabled ?? false, userIds: useStore().allowlist() },
      };
    },
    linkLimiter: createFixedWindowLimiter({ max: 5, windowMs: 10 * 60_000 }),
    logger: useLogger('bot'),
  }),
);

const useRouter = once(() => {
  const handlers = useBotHandlers();
  return createInteractionRouter({
    boundGuildId: () => useStore().binding()?.guildId ?? null,
    logger: useLogger('bot'),
    commands: handlers.commands,
    components: handlers.components,
  });
});

export const useBot = once(() =>
  createBotRunner({
    createDiscord: useCreateDiscord(),
    loadToken: () => useSetup().botToken(),
    guildId: () => useStore().binding()?.guildId ?? null,
    commands: BOT_COMMANDS,
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
