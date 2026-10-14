import { describe, expect, it } from 'vitest';
import { buildCatalog, findCase } from '../../src/s3/catalog.js';
import { BASE_PERMISSIONS, genieOverwrite, lockedProfile, openProfile } from '../../src/s3/profiles.js';
import { CHANNEL_ACTIONS, LOCK_DENIES, THREAD_ACTIONS, type EffectiveCase, type Overwrite, type WriteCase } from '../../src/s3/types.js';

const catalog = buildCatalog();
const effective = catalog.filter((c): c is EffectiveCase => c.kind === 'effective');
const writes = catalog.filter((c): c is WriteCase => c.kind === 'write');
const ids = catalog.map((c) => c.id);
const byTarget = (ows: Overwrite[], target: string) => ows.find((o) => o.target === target);

describe('buildCatalog: completeness', () => {
  it.each([
    'R1-default-open-outsider',
    'R1-nosend-open-outsider',
    'R1-default-locked-outsider',
    'R1-nosend-locked-outsider',
    'R2-default-open-staffer',
    'R2-nosend-open-staffer',
    'R3-default-open-organizer',
    'R4-default-locked-staffer',
    'R4-nosend-locked-staffer',
    'R5-default-locked-organizer',
    'R6-default-open-admin',
    'R6-nosend-open-admin',
    'R6-default-locked-admin',
    'R6-nosend-locked-admin',
    'R7-nosend-locked-sendrole',
    'R8-default-category-staffer',
    'R8-default-category-outsider',
    'R9-default-category-outsider',
    'R10-default-open-staffer-public',
    'R10-default-open-outsider-public',
    'R11-default-open-staffer-private-added',
    'R11-default-open-staffer-private-notadded',
    'R12-default-locked-staffer-public',
    'R12-default-locked-staffer-public-archived',
    'R12-default-locked-staffer-private-added',
    'R12-default-locked-admin-public',
    'R12-default-locked-admin-public-archived',
    'R12-default-locked-admin-private-added',
  ])('contains %s', (id) => {
    expect(ids).toContain(id);
  });

  it('has exactly the 16 expanded write cases', () => {
    expect(writes.map((w) => w.id).sort()).toEqual(
      [
        'W0-default-createcategory',
        'W0-default-create',
        'W0-nosend-createcategory',
        'W0-nosend-create',
        'W1-default-mroverwrite',
        'W1-default-nomroverwrite',
        'W1-nosend-mroverwrite',
        'W1-nosend-nomroverwrite',
        'W2-default-mroverwrite',
        'W2-default-nomroverwrite',
        'W2-nosend-mroverwrite',
        'W2-nosend-nomroverwrite',
        'W3-default-mroverwrite',
        'W4-default-mroverwrite',
        'W5-default-mroverwrite',
        'W5-default-nomroverwrite',
      ].sort(),
    );
  });

  it('gives every case a unique ID that follows the ID scheme', () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(
        /^(R\d+-(default|nosend)-(open|locked|category)-(outsider|staffer|organizer|admin|sendrole)(-(public|public-archived|private-added|private-notadded))?|W\d-(default|nosend)-(createcategory|create|mroverwrite|nomroverwrite))$/,
      );
    }
  });

  it('lists each effective case\'s actions in the fixed order, send last', () => {
    for (const c of effective) {
      expect(c.actions).toEqual(c.thread ? THREAD_ACTIONS : CHANNEL_ACTIONS);
      expect(c.actions.at(-1)).toBe('send');
    }
  });

  it('runs the write cases before the effective cases', () => {
    const firstEffective = catalog.findIndex((c) => c.kind === 'effective');
    const lastWrite = catalog.map((c) => c.kind).lastIndexOf('write');
    expect(lastWrite).toBeLessThan(firstEffective);
  });

  it('is deterministic', () => {
    expect(buildCatalog()).toEqual(catalog);
  });
});

describe('profiles', () => {
  it('locked: @everyone denies View plus the five lock permissions and allows nothing', () => {
    const c = findCase('R4-default-locked-staffer') as EffectiveCase;
    const locked = c.genieWrites!.at(-1)!;
    const everyone = byTarget(locked, 'everyone')!;
    expect(everyone.deny.sort()).toEqual(['ViewChannel', ...LOCK_DENIES].sort());
    expect(everyone.allow).toEqual([]);
  });

  it('locked: the organizer role and every member overwrite except genie\'s deny the five and keep View and Read History', () => {
    const c = findCase('R4-default-locked-staffer') as EffectiveCase;
    const locked = c.genieWrites!.at(-1)!;
    for (const o of locked.filter((o) => o.target !== 'everyone' && o.target !== 'member:genie')) {
      expect(o.deny.sort()).toEqual([...LOCK_DENIES].sort());
      expect(o.allow.sort()).toEqual(['ReadMessageHistory', 'ViewChannel']);
    }
    expect(byTarget(locked, 'member:subject')!.allowOther).toEqual(['AttachFiles']);
    expect(byTarget(locked, 'member:subject')!.allow).not.toContain('SendMessages');
  });

  it('locked: genie\'s own overwrite is unchanged from open', () => {
    const c = findCase('R4-default-locked-staffer') as EffectiveCase;
    const [open, locked] = c.genieWrites!;
    expect(byTarget(locked!, 'member:genie')).toEqual(byTarget(open!, 'member:genie'));
    expect(byTarget(open!, 'member:genie')).toEqual(genieOverwrite());
  });

  it('locked cases are written the way the lock job finds them: open, then locked', () => {
    for (const c of effective.filter((c) => c.profile === 'locked')) {
      expect(c.genieWrites).toHaveLength(2);
      expect(c.genieWrites![0]).toEqual(openProfile(c.subject === 'staffer' || c.subject === 'sendrole'));
      expect(c.genieWrites![1]).toEqual(lockedProfile(c.subject === 'staffer' || c.subject === 'sendrole'));
    }
  });

  it('open: @everyone denies View only; a staffer is allowed View, Send, Read History and Attach Files', () => {
    const open = openProfile(true);
    expect(byTarget(open, 'everyone')).toMatchObject({ allow: [], deny: ['ViewChannel'] });
    expect(byTarget(open, 'member:subject')).toMatchObject({
      allow: ['ReadMessageHistory', 'SendMessages', 'ViewChannel'],
      allowOther: ['AttachFiles'],
    });
    expect(byTarget(open, 'role:organizer')).toMatchObject({ allow: ['ViewChannel'], deny: [] });
  });

  it('an outsider has no overwrite of its own; member:other is always a staffer', () => {
    const c = findCase('R1-default-open-outsider') as EffectiveCase;
    expect(byTarget(c.genieWrites![0]!, 'member:subject')).toBeUndefined();
    expect(byTarget(c.genieWrites![0]!, 'member:other')).toBeDefined();
  });

  it('bases: default grants the thread and reaction permissions, nosend only View and Read History', () => {
    expect(BASE_PERMISSIONS.nosend).toEqual(['ReadMessageHistory', 'ViewChannel']);
    expect(BASE_PERMISSIONS.default).toEqual(expect.arrayContaining(['SendMessages', 'AddReactions', 'CreatePrivateThreads']));
  });
});

describe('special rows', () => {
  it('R8: genie writes nothing; the category carries the arranged overwrites', () => {
    const c = findCase('R8-default-category-staffer') as EffectiveCase;
    expect(c.genieWrites).toBeNull();
    expect(c.createdUnderCategoryWithoutOverwrites).toBe(true);
    const cat = c.category!.overwrites;
    expect(byTarget(cat, 'everyone')!.deny).toEqual(['ViewChannel']);
    expect(byTarget(cat, 'member:genie')).toEqual(genieOverwrite());
    expect(byTarget(cat, 'member:subject')).toBeDefined();
    expect(byTarget(cat, 'member:other')).toBeDefined();
    expect(byTarget((findCase('R8-default-category-outsider') as EffectiveCase).category!.overwrites, 'member:subject')).toBeUndefined();
  });

  it('R9: the category denies @everyone; genie writes the open profile minus the @everyone entry', () => {
    const c = findCase('R9-default-category-outsider') as EffectiveCase;
    expect(byTarget(c.category!.overwrites, 'everyone')!.deny).toEqual(['ViewChannel']);
    expect(c.genieWrites).toHaveLength(1);
    expect(byTarget(c.genieWrites![0]!, 'everyone')).toBeUndefined();
    expect(byTarget(c.genieWrites![0]!, 'member:genie')).toBeDefined();
  });

  it('R7: the subject holds a role that grants Send in the guild base', () => {
    const c = findCase('R7-nosend-locked-sendrole') as EffectiveCase;
    expect(c.roles.find((r) => r.key === 'role:sendrole')!.permissions).toEqual(['SendMessages']);
    expect(c.subjectRoles).toContain('role:sendrole');
  });

  it('admin subjects hold a role with Administrator and are not in the audience', () => {
    const c = findCase('R6-default-locked-admin') as EffectiveCase;
    expect(c.roles.find((r) => r.key === 'role:admin')!.permissions).toEqual(['Administrator']);
    expect(c.subjectRoles).toEqual(['role:admin']);
    expect(byTarget(c.genieWrites![1]!, 'member:subject')).toBeUndefined();
  });

  it('organizer subjects hold the organizer role', () => {
    expect((findCase('R3-default-open-organizer') as EffectiveCase).subjectRoles).toEqual(['role:organizer']);
  });
});

describe('write cases', () => {
  const w = (id: string) => findCase(id) as WriteCase;

  it('classifies the production contexts', () => {
    expect(w('W0-default-createcategory').productionRole).toBe('create');
    expect(w('W0-nosend-create').productionRole).toBe('create');
    expect(w('W1-default-mroverwrite').productionRole).toBe('edit');
    expect(w('W2-nosend-mroverwrite').productionRole).toBe('edit');
    expect(w('W1-nosend-nomroverwrite').productionRole).toBe('fallback');
    expect(w('W2-default-nomroverwrite').productionRole).toBeNull();
    expect(w('W3-default-mroverwrite').productionRole).toBeNull();
    expect(w('W5-default-nomroverwrite').productionRole).toBeNull();
  });

  it('creates go through the create path with no prior overwrites', () => {
    expect(w('W0-default-create')).toMatchObject({ path: 'create', target: 'channel', mrOverwrite: null, overwritesBefore: [] });
    expect(w('W0-default-createcategory').target).toBe('category');
  });

  it('the Manage Roles overwrite variants differ only in genie\'s prior overwrite', () => {
    expect(w('W1-default-mroverwrite').overwritesBefore).toEqual([genieOverwrite()]);
    expect(w('W1-default-nomroverwrite').overwritesBefore).toEqual([]);
    expect(w('W2-default-mroverwrite').overwritesBefore).toEqual(openProfile(false));
  });

  it('W3 and W4 use a role above genie; W5 allows Mention Everyone', () => {
    expect(w('W3-default-mroverwrite').roles.find((r) => r.aboveGenie)).toBeDefined();
    expect(w('W4-default-mroverwrite').otherRoles).toContain('role:high');
    expect(w('W5-default-nomroverwrite').attempted.some((o) => o.allowOther.includes('MentionEveryone'))).toBe(true);
  });

  it('every write case states its base', () => {
    for (const c of writes) expect(['default', 'nosend']).toContain(c.base);
  });
});
