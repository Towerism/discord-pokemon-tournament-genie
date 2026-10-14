/**
 * Channel permission overwrites in Genie's terms, shared by the port, the fake, the plan and the audit. The
 * `@everyone` overwrite targets the guild ID on Discord; only the adapter maps it.
 */
export type OverwriteTarget = { kind: 'everyone' } | { kind: 'role'; id: string } | { kind: 'member'; id: string };

export interface Overwrite {
  target: OverwriteTarget;
  allow: bigint;
  deny: bigint;
}

type Bits = { allow?: bigint; deny?: bigint };

/** `guildId` is unused in Genie's form; it is taken so call sites read like Discord's. */
export const everyone = (_guildId: string, bits: Bits): Overwrite => ({ target: { kind: 'everyone' }, allow: bits.allow ?? 0n, deny: bits.deny ?? 0n });
export const role = (id: string, bits: Bits): Overwrite => ({ target: { kind: 'role', id }, allow: bits.allow ?? 0n, deny: bits.deny ?? 0n });
export const member = (id: string, bits: Bits): Overwrite => ({ target: { kind: 'member', id }, allow: bits.allow ?? 0n, deny: bits.deny ?? 0n });

export const targetKey = (t: OverwriteTarget): string => (t.kind === 'everyone' ? 'everyone' : `${t.kind}:${t.id}`);

/** A canonical, order-free form: one entry per target, sorted, empty entries kept (Discord stores them). */
export function canonical(overwrites: readonly Overwrite[]): string[] {
  return overwrites.map((o) => `${targetKey(o.target)}|${o.allow.toString()}|${o.deny.toString()}`).sort();
}

/** Set equality, as `setOverwrites` replaces the whole list. */
export function overwritesEqual(a: readonly Overwrite[], b: readonly Overwrite[]): boolean {
  const x = canonical(a);
  const y = canonical(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
