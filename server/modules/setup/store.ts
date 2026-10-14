import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type SealedSecretName, guildBinding, install, loginAudit, organizerAllowlist, sealedSecret } from '../../db/schema';
import type { Grant } from '../../../shared/access/access';

export type Install = typeof install.$inferSelect;
export type GuildBinding = typeof guildBinding.$inferSelect;

/** The install's own tables: the single install row, sealed secrets, the guild binding, the allowlist, the login audit. */
export function createSetupStore(db: Db) {
  const installRow = (): Install | null => db.select().from(install).where(eq(install.id, 1)).get() ?? null;

  return {
    install: installRow,
    ensureInstall(now: number): Install {
      db.insert(install).values({ id: 1, createdAt: now }).onConflictDoNothing().run();
      return installRow()!;
    },
    updateInstall(patch: Partial<Omit<Install, 'id' | 'createdAt'>>): void {
      db.update(install).set(patch).where(eq(install.id, 1)).run();
    },

    sealed(name: SealedSecretName): Buffer | null {
      return db.select().from(sealedSecret).where(eq(sealedSecret.name, name)).get()?.ciphertext ?? null;
    },
    putSealed(name: SealedSecretName, ciphertext: Buffer, now: number): void {
      db.insert(sealedSecret)
        .values({ name, ciphertext, updatedAt: now })
        .onConflictDoUpdate({ target: sealedSecret.name, set: { ciphertext, updatedAt: now } })
        .run();
    },

    binding(): GuildBinding | null {
      return db.select().from(guildBinding).get() ?? null;
    },
    /** Replaces the binding with a new guild (setup): at most one row. */
    bindGuild(guildId: string, name: string, now: number): void {
      db.transaction((tx) => {
        tx.delete(guildBinding).run();
        tx.insert(guildBinding).values({ guildId, name, boundAt: now }).run();
      });
    },
    updateBinding(patch: Partial<Pick<GuildBinding, 'organizerRoleId' | 'headJudgeRoleId' | 'organizerAllowlistEnabled' | 'name'>>): void {
      db.update(guildBinding).set(patch).run();
    },

    allowlist(): string[] {
      return db
        .select({ id: organizerAllowlist.discordUserId })
        .from(organizerAllowlist)
        .orderBy(asc(organizerAllowlist.addedAt), asc(organizerAllowlist.discordUserId))
        .all()
        .map((r) => r.id);
    },
    replaceAllowlist(userIds: readonly string[], enabled: boolean, now: number): void {
      db.transaction((tx) => {
        const kept = new Map(tx.select().from(organizerAllowlist).all().map((r) => [r.discordUserId, r.addedAt]));
        tx.delete(organizerAllowlist).run();
        if (userIds.length) {
          tx.insert(organizerAllowlist)
            .values(userIds.map((id) => ({ discordUserId: id, addedAt: kept.get(id) ?? now })))
            .run();
        }
        tx.update(guildBinding).set({ organizerAllowlistEnabled: enabled }).run();
      });
    },

    audit(discordUserId: string, grant: Grant, now: number): void {
      db.insert(loginAudit).values({ discordUserId, grant, at: now }).run();
    },
    auditRows() {
      return db.select().from(loginAudit).orderBy(asc(loginAudit.id)).all();
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(() => fn());
    },
  };
}

export type SetupStore = ReturnType<typeof createSetupStore>;
