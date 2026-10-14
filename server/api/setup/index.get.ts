/** The wizard's progress (never a secret). 410 once setup is complete, which is how pages know. */
export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  const session = await getUserSession(event);
  const { complete: _complete, ...progress } = useSetup().progress();
  return { complete: false as const, unlocked: session.setup?.bootId === bootId, ...progress };
});
