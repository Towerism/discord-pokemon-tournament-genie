/**
 * The staff directory (§5.3): who a person is in Discord and in Play! Pokémon. The organizer links people; `/link`
 * only records a claim, which never grants channel access until the organizer confirms it.
 */
import type { Clock, Logger } from '@towerism/selfhost-kit';
import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { staffMember } from '../../db/schema';
import { ServiceError, notFound } from '../errors';

export type StaffRow = typeof staffMember.$inferSelect;

export interface StaffMember {
  id: number;
  displayName: string;
  playerId: string | null;
  linkState: StaffRow['linkState'];
  discordUserId: string | null;
  claimedDiscordUserId: string | null;
}

export type ClaimOutcome = { outcome: 'invalid' } | { outcome: 'already_linked'; name: string } | { outcome: 'taken' } | { outcome: 'recorded' };

export const PLAYER_ID = /^\d{1,10}$/;

const view = (r: StaffRow): StaffMember => ({
  id: r.id,
  displayName: r.displayName,
  playerId: r.playerId,
  linkState: r.linkState,
  discordUserId: r.discordUserId,
  claimedDiscordUserId: r.claimedDiscordUserId,
});

export function createDirectoryService(opts: {
  db: Db;
  clock: Clock;
  logger: Logger;
  /**
   * Called inside the transaction when a member's linked Discord user changes; answers the sync job IDs it queued.
   * Implemented by event-days, so the dependency stays one-way (FR-13).
   */
  onLinkChanged: (staffMemberId: number) => number[];
  /** Whether a day's staff refers to the member (a claim-created row is then kept, not deleted). */
  isReferenced?: (staffMemberId: number) => boolean;
}) {
  const { db, clock, logger, onLinkChanged, isReferenced = () => false } = opts;

  const row = (id: number) => db.select().from(staffMember).where(eq(staffMember.id, id)).get() ?? null;
  const need = (id: number) => row(id) ?? (() => {
    throw notFound('staff member');
  })();
  const byPlayer = (playerId: string) => db.select().from(staffMember).where(eq(staffMember.playerId, playerId)).get() ?? null;
  const byUser = (userId: string) => db.select().from(staffMember).where(eq(staffMember.discordUserId, userId)).get() ?? null;
  const byClaim = (userId: string) => db.select().from(staffMember).where(eq(staffMember.claimedDiscordUserId, userId)).get() ?? null;

  function assertFree(id: number | null, patch: { playerId?: string | null; discordUserId?: string | null }) {
    if (patch.playerId) {
      const holder = byPlayer(patch.playerId);
      if (holder && holder.id !== id) throw new ServiceError(409, 'player_id_taken', 'Another staff member has that player ID.');
    }
    if (patch.discordUserId) {
      const holder = byUser(patch.discordUserId);
      if (holder && holder.id !== id) throw new ServiceError(409, 'discord_user_taken', 'That Discord member is linked to someone else.');
    }
  }

  /** Clears a user's pending claim. A row the claim itself created goes away unless a day refers to it. */
  function dropClaimOf(userId: string): void {
    const claimed = byClaim(userId);
    if (!claimed) return;
    if (claimed.createdByClaim && !isReferenced(claimed.id)) {
      db.delete(staffMember).where(eq(staffMember.id, claimed.id)).run();
    } else {
      db.update(staffMember)
        .set({ linkState: 'unlinked', claimedDiscordUserId: null, claimedAt: null, updatedAt: clock.now() })
        .where(eq(staffMember.id, claimed.id))
        .run();
    }
  }

  return {
    list(): StaffMember[] {
      return db.select().from(staffMember).orderBy(asc(sql`lower(${staffMember.displayName})`), asc(staffMember.id)).all().map(view);
    },
    get(id: number): StaffMember | null {
      const r = row(id);
      return r ? view(r) : null;
    },
    byIds(ids: readonly number[]): StaffMember[] {
      const wanted = new Set(ids);
      return this.list().filter((s) => wanted.has(s.id));
    },
    byDiscordUser(userId: string): StaffMember | null {
      const r = byUser(userId);
      return r ? view(r) : null;
    },

    create(input: { displayName: string; playerId?: string | null; discordUserId?: string | null }): StaffMember {
      const now = clock.now();
      return db.transaction(() => {
        assertFree(null, input);
        const created = db
          .insert(staffMember)
          .values({
            displayName: input.displayName.trim(),
            playerId: input.playerId ?? null,
            discordUserId: input.discordUserId ?? null,
            linkState: input.discordUserId ? 'linked' : 'unlinked',
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        logger.info('Staff member created.', { staffMemberId: created.id, linked: created.linkState === 'linked' });
        return view(created);
      });
    },

    update(id: number, patch: { displayName?: string; playerId?: string | null; discordUserId?: string | null }): { staff: StaffMember; syncJobIds: number[] } {
      return db.transaction(() => {
        const current = need(id);
        assertFree(id, patch);
        const changes: Partial<StaffRow> = { updatedAt: clock.now() };
        if (patch.displayName !== undefined) changes.displayName = patch.displayName.trim();
        if (patch.playerId !== undefined) changes.playerId = patch.playerId;
        const relinked = patch.discordUserId !== undefined && patch.discordUserId !== current.discordUserId;
        if (relinked) {
          changes.discordUserId = patch.discordUserId;
          changes.linkState = patch.discordUserId ? 'linked' : 'unlinked';
          changes.claimedDiscordUserId = null;
          changes.claimedAt = null;
        }
        db.update(staffMember).set(changes).where(eq(staffMember.id, id)).run();
        // Only a member who held a Discord user can lose access by a relink or unlink.
        const syncJobIds = relinked && current.discordUserId !== null ? onLinkChanged(id) : [];
        return { staff: view(need(id)), syncJobIds };
      });
    },

    confirmClaim(id: number): { staff: StaffMember; syncJobIds: number[] } {
      return db.transaction(() => {
        const current = need(id);
        if (current.linkState !== 'claimed' || !current.claimedDiscordUserId) throw new ServiceError(409, 'no_claim', 'This staff member has no claim to confirm.');
        assertFree(id, { discordUserId: current.claimedDiscordUserId });
        db.update(staffMember)
          .set({ linkState: 'linked', discordUserId: current.claimedDiscordUserId, claimedDiscordUserId: null, claimedAt: null, createdByClaim: false, updatedAt: clock.now() })
          .where(eq(staffMember.id, id))
          .run();
        logger.info('Claim confirmed.', { staffMemberId: id });
        return { staff: view(need(id)), syncJobIds: onLinkChanged(id) };
      });
    },

    /** Answers the row as it stands, or `null` when the claim had created it and it is gone. */
    rejectClaim(id: number): StaffMember | null {
      return db.transaction(() => {
        const current = need(id);
        if (current.linkState !== 'claimed' || !current.claimedDiscordUserId) throw new ServiceError(409, 'no_claim', 'This staff member has no claim to reject.');
        dropClaimOf(current.claimedDiscordUserId);
        logger.info('Claim rejected.', { staffMemberId: id });
        return this.get(id);
      });
    },

    /** `/link player-id:` (§5.3). Records a claim; it never links. */
    claim(input: { userId: string; playerId: string; displayName: string }): ClaimOutcome {
      if (!PLAYER_ID.test(input.playerId)) return { outcome: 'invalid' };
      return db.transaction(() => {
        const linked = byUser(input.userId);
        if (linked) return { outcome: 'already_linked', name: linked.displayName };
        const holder = byPlayer(input.playerId);
        if (holder && (holder.linkState === 'linked' || (holder.linkState === 'claimed' && holder.claimedDiscordUserId !== input.userId))) {
          return { outcome: 'taken' };
        }
        if (holder?.claimedDiscordUserId === input.userId) return { outcome: 'recorded' };
        dropClaimOf(input.userId);
        const now = clock.now();
        if (holder) {
          db.update(staffMember)
            .set({ linkState: 'claimed', claimedDiscordUserId: input.userId, claimedAt: now, updatedAt: now })
            .where(eq(staffMember.id, holder.id))
            .run();
        } else {
          db.insert(staffMember)
            .values({
              displayName: input.displayName.trim().slice(0, 64) || input.playerId,
              playerId: input.playerId,
              claimedDiscordUserId: input.userId,
              claimedAt: now,
              createdByClaim: true,
              linkState: 'claimed',
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
        logger.info('Claim recorded.', { userId: input.userId });
        return { outcome: 'recorded' };
      });
    },
  };
}

export type DirectoryService = ReturnType<typeof createDirectoryService>;
