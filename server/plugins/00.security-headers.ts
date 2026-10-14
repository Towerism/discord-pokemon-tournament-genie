import { securityHeadersPlugin } from '@towerism/selfhost-kit/nitro';
import { EXTRA_CSP } from '../../shared/csp';

/** The kit's security headers on every response; HSTS only for an https site (§9). */
export default defineNitroPlugin(securityHeadersPlugin({ siteUrl: useRuntimeConfig().public.siteUrl, extraCsp: EXTRA_CSP }));
