/** While setup is open every page is the wizard; afterwards every page but /login needs a session. */
export default defineNuxtRouteMiddleware(async (to) => {
  const { complete, refresh } = useSetupComplete();
  const done = complete.value === true ? true : await refresh();
  if (!done) return to.path === '/setup' ? undefined : navigateTo('/setup');
  if (to.path === '/setup') return navigateTo('/');
  const { loggedIn, fetch } = useUserSession();
  if (!loggedIn.value) await fetch();
  if (!loggedIn.value && to.path !== '/login') return navigateTo('/login');
  if (loggedIn.value && to.path === '/login') return navigateTo('/');
});
