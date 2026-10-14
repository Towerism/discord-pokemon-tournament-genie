export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'directory' });
  return { staff: useDirectory().list() };
});
