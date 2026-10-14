/** Liveness: the process serves HTTP. The bot's state never affects it. */
export default defineEventHandler(() => ({ status: 'ok' }));
