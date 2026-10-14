export default defineEventHandler(async (event) => {
  const { principal, session } = await requirePrincipal(event, { kind: 'website' });
  return {
    user: session.user,
    grant: principal.grant,
    isOwner: principal.grant === 'owner',
    isOrganizer: true,
  };
});
