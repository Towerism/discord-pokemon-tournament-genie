import { enforceRateLimit } from '@towerism/selfhost-kit/nitro';
import type { H3Event } from 'h3';
import type { ZodType } from 'zod';
import { type Principal, type Resource, canSee, isOrganizer } from '../../shared/access/access';
import { ServiceError } from '../modules/errors';
import { SetupError } from '../modules/setup/errors';
import { allowedOrigin } from './origin';

/** An API error with `data.code` (architecture §7). */
export function apiError(statusCode: number, code: string, message: string, data: Record<string, unknown> = {}) {
  return createError({ statusCode, message, data: { code, ...data } });
}

/** Runs a module call, turning its refusals into API errors. */
export async function handled<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SetupError || err instanceof ServiceError) throw apiError(err.status, err.code, err.message, err.data);
    throw err;
  }
}

/** A route's integer ID parameter; anything else is an unknown resource. */
export function idParam(event: H3Event, name = 'id'): number {
  const raw = getRouterParam(event, name) ?? '';
  const id = Number(raw);
  if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(id)) throw apiError(404, 'not_found', 'Not found.');
  return id;
}

/** A route's Discord ID parameter; anything else is an unknown resource. */
export function snowflakeParam(event: H3Event, name: string): string {
  const raw = getRouterParam(event, name) ?? '';
  if (!/^\d{17,20}$/.test(raw)) throw apiError(404, 'not_found', 'Not found.');
  return raw;
}

/**
 * The principal, if they may act on the day (ADR-0010). An unknown day is 404 for everyone; an existing day a
 * non-organizer can't use is 403 (§11's auth matrix). Organizers pass without building the plan.
 */
export async function requireDay(event: H3Event, dayId: number, action: 'read' | 'preview' | 'sync' | 'edit' | 'open' | 'close' | 'closeout') {
  const { principal, session } = await requirePrincipal(event, { kind: 'website' });
  const plan = await handled(() => (isOrganizer(principal.grant) ? (useEventDays().plan(dayId), null) : useProvisioning().accessPlan(dayId, principal)));
  if (plan && !canSee(principal, { kind: 'day', action }, plan)) throw apiError(403, 'forbidden', 'You can’t see this.');
  return { principal, session };
}

/** Close-out's confirmations (§6.5): an irreversible step needs `{ confirm: true }`. */
export function requireConfirmed(body: { confirm?: boolean }): void {
  if (body.confirm !== true) throw apiError(422, 'confirmation_required', 'Confirm this first: it can’t be undone.');
}

export function originConfig() {
  const config = useRuntimeConfig();
  return { siteUrl: config.public.siteUrl, port: listeningPort() };
}

function listeningPort(): number {
  return Number(process.env.NITRO_PORT || process.env.PORT || 3001);
}

/** ADR-0013: secrets and logins only on the site URL (https, via Caddy) or the owner's localhost. */
export function requireAllowedOrigin(event: H3Event): string {
  const origin = allowedOrigin(
    {
      remoteAddress: event.node.req.socket?.remoteAddress,
      host: getRequestHeader(event, 'host'),
      forwardedProto: getRequestHeader(event, 'x-forwarded-proto'),
      forwardedHost: getRequestHeader(event, 'x-forwarded-host'),
      trusted: useTrustedProxies(),
    },
    originConfig(),
  );
  if (!origin) {
    throw apiError(403, 'insecure_origin', 'Open Genie through its https:// address (or http://localhost on the host itself).');
  }
  return origin;
}

/** Every `/api/setup/*` route answers 410 once setup is complete. */
export function requireSetupIncomplete(): void {
  if (useSetup().isComplete()) throw apiError(410, 'setup_complete', 'Setup is already complete.');
}

/** The wizard steps after the code need the browser that entered it, in this process. */
export async function requireSetupUnlocked(event: H3Event) {
  const session = await getUserSession(event);
  if (session.setup?.bootId !== bootId) throw apiError(403, 'setup_locked', 'Enter the setup code first.');
  return session;
}

export function rateLimit(event: H3Event, route: 'login' | 'callback' | 'setup'): void {
  enforceRateLimit(event, { limiter: useAuthLimiters()[route], trusted: useTrustedProxies() });
}

/** The signed-in principal, if `canSee` lets them see `resource` (ADR-0010). */
export async function requirePrincipal(event: H3Event, resource: Resource) {
  const session = await getUserSession(event);
  if (!session.user || !session.grant) throw apiError(401, 'unauthenticated', 'Log in first.');
  const principal: Principal = { userId: session.user.id, grant: session.grant, holdsHeadJudgeRole: session.holdsHeadJudgeRole ?? false };
  if (!canSee(principal, resource)) {
    throw resource.kind === 'organizer_allowlist'
      ? apiError(403, 'owner_only', 'Only the install owner can do this.')
      : apiError(403, 'forbidden', 'You can’t see this.');
  }
  return { principal, session };
}

export async function readValid<T>(event: H3Event, schema: ZodType<T>): Promise<T> {
  const body = await readBody(event).catch(() => undefined);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError(400, 'invalid_body', 'The request body is invalid.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
