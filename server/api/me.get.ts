import { canSee, isOrganizer } from '../../shared/access/access';

export default defineEventHandler(async (event) => {
  const { principal, session } = await requirePrincipal(event, { kind: 'website' });
  return {
    user: session.user,
    grant: principal.grant,
    isOwner: principal.grant === 'owner',
    isOrganizer: canSee(principal, { kind: 'settings' }),
    // A head judge's way in: `GET /api/days` is organizer only.
    headJudgeDays: isOrganizer(principal.grant) ? [] : useEventDays().headJudgeDays(principal.userId, principal.holdsHeadJudgeRole),
  };
});
