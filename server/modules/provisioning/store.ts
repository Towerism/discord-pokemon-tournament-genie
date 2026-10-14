import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { orphanChannel, provisionedChannel } from '../../db/schema';

export type ProvisionedRow = typeof provisionedChannel.$inferSelect;
export type OrphanRow = typeof orphanChannel.$inferSelect;

/** The provisioning module's own tables: the channels Genie owns, and the ones it found but doesn't. */
export function createProvisioningStore(db: Db) {
  return {
    channels(dayId: number): ProvisionedRow[] {
      return db.select().from(provisionedChannel).where(eq(provisionedChannel.dayId, dayId)).orderBy(asc(provisionedChannel.id)).all();
    },
    present(dayId: number): ProvisionedRow[] {
      return db
        .select()
        .from(provisionedChannel)
        .where(and(eq(provisionedChannel.dayId, dayId), eq(provisionedChannel.state, 'present')))
        .orderBy(asc(provisionedChannel.id))
        .all();
    },
    record(row: { dayId: number; guildId: string; eventId: number | null; key: string; channelId: string; hash: string; now: number }): void {
      db.insert(provisionedChannel)
        .values({
          dayId: row.dayId,
          guildId: row.guildId,
          eventId: row.eventId,
          blueprintChannelKey: row.key,
          discordChannelId: row.channelId,
          appliedOverwritesHash: row.hash,
          state: 'present',
          createdAt: row.now,
          updatedAt: row.now,
        })
        .run();
    },
    update(id: number, patch: Partial<Pick<ProvisionedRow, 'appliedOverwritesHash' | 'state' | 'messageId' | 'messagePinned'>>, now: number): void {
      db.update(provisionedChannel).set({ ...patch, updatedAt: now }).where(eq(provisionedChannel.id, id)).run();
    },
    isRecorded(channelId: string): boolean {
      return db.select({ id: provisionedChannel.id }).from(provisionedChannel).where(eq(provisionedChannel.discordChannelId, channelId)).get() !== undefined;
    },

    orphans(dayId: number): OrphanRow[] {
      return db.select().from(orphanChannel).where(eq(orphanChannel.dayId, dayId)).orderBy(asc(orphanChannel.foundAt), asc(orphanChannel.discordChannelId)).all();
    },
    orphan(dayId: number, channelId: string): OrphanRow | null {
      return db.select().from(orphanChannel).where(and(eq(orphanChannel.dayId, dayId), eq(orphanChannel.discordChannelId, channelId))).get() ?? null;
    },
    /** Replaces the day's orphans of one kind, keeping when each was first found. */
    replaceOrphans(dayId: number, guildId: string, kind: OrphanRow['kind'], found: { id: string; name: string }[], now: number): void {
      db.transaction(() => {
        const known = new Map(this.orphans(dayId).filter((o) => o.kind === kind).map((o) => [o.discordChannelId, o]));
        db.delete(orphanChannel).where(and(eq(orphanChannel.dayId, dayId), eq(orphanChannel.kind, kind))).run();
        for (const f of found) {
          db.insert(orphanChannel)
            .values({ discordChannelId: f.id, dayId, guildId, kind, name: f.name, foundAt: known.get(f.id)?.foundAt ?? now })
            .onConflictDoNothing()
            .run();
        }
      });
    },
    addOrphans(dayId: number, guildId: string, kind: OrphanRow['kind'], found: { id: string; name: string }[], now: number): void {
      for (const f of found) db.insert(orphanChannel).values({ discordChannelId: f.id, dayId, guildId, kind, name: f.name, foundAt: now }).onConflictDoNothing().run();
    },
    dropOrphan(channelId: string): void {
      db.delete(orphanChannel).where(eq(orphanChannel.discordChannelId, channelId)).run();
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn);
    },
  };
}

export type ProvisioningStore = ReturnType<typeof createProvisioningStore>;
