import { getCookie, getQuery } from 'h3';

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
  // nuxt-auth-utils compares `state` with its cookie and treats a missing state and a missing cookie as equal
  // (undefined === undefined). A callback without either would let anyone hand a victim a code minted for
  // their own account: a login CSRF that, during setup, binds the attacker as owner. Refuse it here.
  if (query.code !== undefined) {
    const state = typeof query.state === 'string' ? query.state : '';
    if (!state || !getCookie(event, 'nuxt-auth-state')) {
      log.warn('Discord login callback without its state; refused.');
      return sendRedirect(event, '/login?error=login_failed');
    }
  }

  const client = await handled(() => useSetup().oauthClient());
  if (!client) return sendRedirect(event, '/setup');

  const { discord } = useRuntimeConfig(event);
  const login = defineOAuthDiscordEventHandler({
    config: {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectURL: oauthRedirectUrl(origin, originConfig()),
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
