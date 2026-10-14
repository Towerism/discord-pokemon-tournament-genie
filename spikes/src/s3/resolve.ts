import type { ResolvedOverwrite } from './ports.js';
import { PERMISSIONS, type MemberKey, type Overwrite, type OverwriteTarget, type PermissionName } from './types.js';

export type Ids = {
  guildId: string;
  roles: Record<string, string>;
  members: Record<MemberKey, string>;
};

const MODELLED = new Set<string>(PERMISSIONS);

export function resolve(overwrites: Overwrite[], ids: Ids): ResolvedOverwrite[] {
  return overwrites.map((o) => {
    let id: string | undefined;
    let type: 'role' | 'member';
    if (o.target === 'everyone') {
      id = ids.guildId;
      type = 'role';
    } else if (o.target.startsWith('role:')) {
      id = ids.roles[o.target];
      type = 'role';
    } else {
      id = ids.members[o.target as MemberKey];
      type = 'member';
    }
    if (id === undefined) throw new Error(`no ID for overwrite target ${o.target}`);
    return { id, type, allow: [...o.allow, ...o.allowOther].sort(), deny: [...o.deny, ...o.denyOther].sort() };
  });
}

/** Maps read-back overwrites to symbolic keys; an ID the run didn't create becomes `…:unknown`, never a snowflake. */
export function unresolve(overwrites: ResolvedOverwrite[], ids: Ids): Overwrite[] {
  const byId = new Map<string, OverwriteTarget>();
  byId.set(ids.guildId, 'everyone');
  for (const [key, id] of Object.entries(ids.roles)) byId.set(id, key as OverwriteTarget);
  for (const [key, id] of Object.entries(ids.members)) byId.set(id, key as OverwriteTarget);
  const split = (perms: string[]) => ({
    modelled: perms.filter((p) => MODELLED.has(p)).sort() as PermissionName[],
    other: perms.filter((p) => !MODELLED.has(p)).sort(),
  });
  return overwrites.map((o) => {
    const target = byId.get(o.id) ?? (o.type === 'role' ? 'role:unknown' : ('member:unknown' as OverwriteTarget));
    const a = split(o.allow);
    const d = split(o.deny);
    return { target, allow: a.modelled, deny: d.modelled, allowOther: a.other, denyOther: d.other };
  });
}

const key = (o: Overwrite) => JSON.stringify([o.target, [...o.allow].sort(), [...o.deny].sort(), [...o.allowOther].sort(), [...o.denyOther].sort()]);

export function sortOverwrites(os: Overwrite[]): Overwrite[] {
  return [...os].sort((a, b) => a.target.localeCompare(b.target));
}

export function sameOverwrites(a: Overwrite[], b: Overwrite[]): boolean {
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}
