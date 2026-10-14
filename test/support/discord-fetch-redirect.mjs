// Test-only preload for the built app (`node --import`): nuxt-auth-utils fetches the logged-in user from a
// hard-coded https://discord.com/api/users/@me, so that one origin is redirected to the fake Discord named by
// GENIE_TEST_DISCORD_URL. Production code is unchanged; the other Discord URLs are runtime config.
const target = process.env.GENIE_TEST_DISCORD_URL;
if (target) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://discord.com/')) {
      const rewritten = target + url.slice('https://discord.com'.length);
      return realFetch(typeof input === 'string' || input instanceof URL ? rewritten : new Request(rewritten, input), init);
    }
    return realFetch(input, init);
  };
}
