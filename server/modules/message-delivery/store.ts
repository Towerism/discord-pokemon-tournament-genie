import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type DELIVERY_OUTCOMES, deliveredMessage } from '../../db/schema';

export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** `delivered_message`, which only this module reads or writes. */
export function createDeliveryStore(db: Db) {
  const key = (connectionKey: string, messageId: number) => and(eq(deliveredMessage.connectionKey, connectionKey), eq(deliveredMessage.messageId, messageId));
  return {
    outcome(connectionKey: string, messageId: number): DeliveryOutcome | null {
      return db.select({ outcome: deliveredMessage.outcome }).from(deliveredMessage).where(key(connectionKey, messageId)).get()?.outcome ?? null;
    },
    record(connectionKey: string, messageId: number, outcome: DeliveryOutcome, now: number): void {
      db.insert(deliveredMessage).values({ connectionKey, messageId, outcome, createdAt: now }).onConflictDoNothing().run();
    },
    markReported(connectionKey: string, messageId: number, now: number): void {
      db.update(deliveredMessage).set({ reportedAt: now }).where(key(connectionKey, messageId)).run();
    },
    forget(connectionKey: string): void {
      db.delete(deliveredMessage).where(eq(deliveredMessage.connectionKey, connectionKey)).run();
    },
    /** Deletes records created at or before `cutoff`. */
    sweep(cutoff: number): number {
      return db.delete(deliveredMessage).where(lte(deliveredMessage.createdAt, cutoff)).run().changes;
    },
  };
}
