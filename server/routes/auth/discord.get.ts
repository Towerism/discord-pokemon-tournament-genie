import { randomBytes } from 'node:crypto';
import { deleteCookie, getQuery, setCookie } from 'h3';

/**
 * Website login with Discord OAuth (ADR-0004), on an allowed origin only (ADR-0013). The client ID and secret
 * come from the vault; the redirect URL is fixed per allowed origin. During setup a login can only bind the
 * owner, from the browser that unlocked the wizard.
 */
export default defineEventHandler(async (event) => {
  const origin = requireAllowedOrigin(event);
  const query = getQuery(event);
  const callback = query.code !== undefined || query.error !== undefined;
  // Starting a login and completing one are limited separately, so a login costs one hit of each.
  rateLimit(event, callback ? 'callback' : 'login');

  const log = useLogger('login');
  const client = await handled(() => useSetup().oauthClient());
  if (!client) return sendRedirect(event, '/setup');
  const { discord } = useRuntimeConfig(event);
  const redirectURL = oauthRedirectUrl(origin, originConfig());

  if (query.code === undefined && query.error === undefined) {
    // Genie starts the login itself so the expected state lives in the sealed session. nuxt-auth-utils keeps it
    // only in a plain cookie, which a sibling subdomain or another localhost port can plant (login CSRF). The
    // same value goes into the library's cookie, so its own check on the callback still applies.
    const state = randomBytes(32).toString('base64url');
    await setUserSession(event, { oauthState: state });
    setCookie(event, 'nuxt-auth-state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });
    const authorize = new URL(discord.authorizeUrl);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.clientId, redirect_uri: redirectURL, scope: 'identify', state })) {
      authorize.searchParams.set(key, value);
    }
    return sendRedirect(event, authorize.toString());
  }

  // A callback must carry the state of the login this browser started. Anything else is someone else's code.
  const session = await getUserSession(event);
  const state = typeof query.state === 'string' ? query.state : '';
  if (!session.oauthState || state !== session.oauthState) {
    log.warn('Discord login callback that this browser did not start; refused.');
    deleteCookie(event, 'nuxt-auth-state', { path: '/' });
    return sendRedirect(event, '/login?error=login_failed');
  }

  const login = defineOAuthDiscordEventHandler({
    config: {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectURL,
      scope: ['identify'],
      authorizationURL: discord.authorizeUrl,
      tokenURL: discord.tokenUrl,
    },
    async onSuccess(event, { user }) {
      const previous = await getUserSession(event);
      // The wizard unlock survives a login only while setup is still open, in this process.
      const setup = previous.setup?.bootId === bootId && !useSetup().isComplete() ? { setup: previous.setup } : {};
      const outcome = await useLogin().complete({
        user: { id: user.id, username: user.username, globalName: user.global_name ?? null, avatar: user.avatar ?? null },
        unlocked: 'setup' in setup,
      });
      // Replace, never merge: nothing of an earlier user's session may carry over to this one.
      if (outcome.session) await replaceUserSession(event, { ...outcome.session, ...setup });
      else if ('setup' in setup) await replaceUserSession(event, setup);
      else await clearUserSession(event);
      return sendRedirect(event, outcome.redirect);
    },
    onError(event, error) {
      log.warn('Discord login failed.', { err: error });
      return sendRedirect(event, '/login?error=login_failed');
    },
  });
  try {
    return await login(event);
  } catch (err) {
    // nuxt-auth-utils passes only a 401 from the token exchange to onError; Discord answers a bad or reused code
    // with 400, which it throws.
    log.warn('Discord login failed.', { err });
    return sendRedirect(event, '/login?error=login_failed');
  }
});
