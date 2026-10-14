import { jsonErrorHandler } from '@towerism/selfhost-kit/nitro';

/** JSON errors keep the app's security headers. */
export default defineNitroErrorHandler(jsonErrorHandler());
