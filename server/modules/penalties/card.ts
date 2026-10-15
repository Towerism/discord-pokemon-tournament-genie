/**
 * The penalty card (§6.4): a view of the row, never its source. Rendered from the row as it is when the card work
 * runs, so the latest revision always wins.
 */
import type { OutboundMessage } from '../discord/port';
import type { PenaltyView } from './index';

export const EDIT_PREFIX = 'genie:penalty-edit:';
export const VOID_PREFIX = 'genie:penalty-void:';

/** `lastBy` is the display name of whoever made the latest revision (`null`: not known to the directory). */
export function renderCard(p: PenaltyView, eventName: string, lastBy: string | null): OutboundMessage {
  const voided = p.state === 'voided';
  const who = lastBy ?? 'an organizer';
  const footer = voided ? `${eventName} · Voided by ${who}: ${p.voidReason ?? ''}` : p.revision > 1 ? `${eventName} · Edited by ${who} · revision ${p.revision}` : eventName;
  return {
    content: '',
    embed: {
      title: `${voided ? 'VOIDED · ' : ''}Penalty #${p.number} · Round ${p.round}`,
      fields: [
        { name: "Competitor's player ID", value: p.competitorPlayerId },
        { name: 'Category', value: p.category.label },
        { name: 'Severity', value: p.severity },
        { name: 'Penalty', value: p.penaltyType.label },
        { name: 'Judge', value: `${p.judge.name} (${p.judge.playerId})` },
        ...(p.notes ? [{ name: 'Notes', value: p.notes }] : []),
      ],
      footer,
    },
    buttons: voided
      ? []
      : [
          { customId: `${EDIT_PREFIX}${p.id}`, label: 'Edit' },
          { customId: `${VOID_PREFIX}${p.id}`, label: 'Void', style: 'danger' },
        ],
  };
}
