import { getQuery } from 'h3';

/**
 * Website login with Discord OAuth (ADR-0004), on an allowed origin only (ADR-0013). The client ID and secret
 * come from the vault; the redirect URL is fixed per allowed origin. During setup a login can only bind the
 * owner, from the browser that unlocked the wizard.
 */
export default defineEventHandler(async (event) => {
  const origin = requireAllowedOrigin(event);
  const query = getQuery(event);
  if (query.code === undefined && query.error === undefined) rateLimit(event, 'login');

  const client = await handled(() => useSetup().oauthClient());
  if (!client) return sendRedirect(event, '/setup');

  const { discord } = useRuntimeConfig(event);
  const log = useLogger('login');
  return defineOAuthDiscordEventHandler({
    config: {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectURL: oauthRedirectUrl(origin, originConfig()),
      scope: ['identify'],
      authorizationURL: discord.authorizeUrl,
      tokenURL: discord.tokenUrl,
    },
    async onSuccess(event, { user }) {
      const session = await getUserSession(event);
      const outcome = await useLogin().complete({
        user: { id: user.id, username: user.username, globalName: user.global_name ?? null, avatar: user.avatar ?? null },
        unlocked: session.setup?.bootId === bootId,
      });
      if (outcome.session) {
        const { user: sessionUser, grant, checkedAt } = outcome.session;
        await setUserSession(event, { user: sessionUser, grant, checkedAt });
      }
      return sendRedirect(event, outcome.redirect);
    },
    onError(event, error) {
      log.warn('Discord login failed.', { err: error });
      return sendRedirect(event, '/login?error=login_failed');
    },
  })(event);
});
