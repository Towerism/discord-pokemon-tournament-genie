import { requestLogPlugin } from '@towerism/selfhost-kit/nitro';

/** Request ids and one log line per request (§10). */
export default defineNitroPlugin(requestLogPlugin({ logger: rootLogger() }));
