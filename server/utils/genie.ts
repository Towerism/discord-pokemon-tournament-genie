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
import { createInteractionRouter } from '../bot/router';
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
  createLoginService({ store: useStore(), setup: useSetup(), createDiscord: useCreateDiscord(), clock: systemClock, logger: useLogger('login') }),
);

export const useSettings = once(() =>
  createSettingsService({ store: useStore(), setup: useSetup(), createDiscord: useCreateDiscord(), clock: systemClock, logger: useLogger('settings') }),
);

const useRouter = once(() =>
  createInteractionRouter({ boundGuildId: () => useStore().binding()?.guildId ?? null, logger: useLogger('bot'), commands: {} }),
);

export const useBot = once(() =>
  createBotRunner({
    createDiscord: useCreateDiscord(),
    loadToken: () => useSetup().botToken(),
    guildId: () => useStore().binding()?.guildId ?? null,
    commands: [],
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
  return { login: createFixedWindowLimiter(login), setup: createFixedWindowLimiter(setup) };
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
