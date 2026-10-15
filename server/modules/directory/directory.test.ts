import { silentLogger } from '@towerism/selfhost-kit';
import { type FakeClock, fakeClock } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../../../test/support/db';
import type { OpenDatabase } from '../../db/client';
import { ServiceError } from '../errors';
import { type DirectoryService, createDirectoryService } from './index';

let database: OpenDatabase;
let clock: FakeClock;
let directory: DirectoryService;
let linkChanges: number[];

const U = (n: number) => `10000000000000000${n}`;

beforeEach(() => {
  database = freshDb();
  clock = fakeClock(1_000);
  linkChanges = [];
  directory = createDirectoryService({
    db: database.db,
    clock,
    logger: silentLogger,
    onLinkChanged: (id) => {
      linkChanges.push(id);
      return [100 + id];
    },
  });
});
afterEach(() => database.close());

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ServiceError) return `${err.status} ${err.code}`;
    throw err;
  }
  return 'no refusal';
};

describe('the staff directory', () => {
  it('creates a linked member, refuses duplicates, and unlinks', () => {
    const ash = directory.create({ displayName: '  Ash  ', playerId: '1234567', discordUserId: U(1) });
    expect(ash).toMatchObject({ displayName: 'Ash', playerId: '1234567', linkState: 'linked', discordUserId: U(1), claimedDiscordUserId: null });
    expect(refusal(() => directory.create({ displayName: 'Other', playerId: '1234567' }))).toBe('409 player_id_taken');
    const misty = directory.create({ displayName: 'Misty' });
    expect(misty.linkState).toBe('unlinked');
    expect(refusal(() => directory.update(misty.id, { discordUserId: U(1) }))).toBe('409 discord_user_taken');
    const { staff, syncJobIds } = directory.update(ash.id, { discordUserId: null });
    expect(staff.linkState).toBe('unlinked');
    expect(syncJobIds).toEqual([100 + ash.id]);
    expect(linkChanges).toEqual([ash.id]);
  });

  it('only reports a link change when the linked user changes', () => {
    const ash = directory.create({ displayName: 'Ash', discordUserId: U(1) });
    expect(directory.update(ash.id, { displayName: 'Ash K.', playerId: '7654321' }).syncJobIds).toEqual([]);
    expect(directory.update(ash.id, { discordUserId: U(1) }).syncJobIds).toEqual([]);
    expect(directory.update(ash.id, { discordUserId: U(2) }).syncJobIds).toEqual([100 + ash.id]);
    expect(refusal(() => directory.update(999, { displayName: 'x' }))).toBe('404 not_found');
  });

  it('refuses another member’s player ID on update, keeps a member’s own, and clears one', () => {
    const ash = directory.create({ displayName: 'Ash', playerId: '1112223', discordUserId: U(1) });
    const brock = directory.create({ displayName: 'Brock', playerId: '4445556' });
    expect(refusal(() => directory.update(brock.id, { playerId: '1112223' }))).toBe('409 player_id_taken');
    expect(directory.get(brock.id)?.playerId).toBe('4445556');
    expect(directory.update(ash.id, { displayName: 'Ash', playerId: '1112223' }).staff.playerId).toBe('1112223');
    const cleared = directory.update(brock.id, { playerId: null });
    expect(cleared.staff).toMatchObject({ playerId: null, displayName: 'Brock', linkState: 'unlinked', discordUserId: null });
    expect(cleared.syncJobIds).toEqual([]);
    // A second member without a player ID is fine: only a held ID is unique.
    expect(directory.update(ash.id, { playerId: null }).staff.playerId).toBeNull();
    expect(linkChanges).toEqual([]);
  });

  it('edits a claimed member without touching the claim', () => {
    directory.claim({ userId: U(1), playerId: '7654321', displayName: 'Ash Ketchum' });
    const claimed = directory.list()[0]!;
    const { staff, syncJobIds } = directory.update(claimed.id, { displayName: 'Ash', playerId: '7654322' });
    expect(staff).toMatchObject({ displayName: 'Ash', playerId: '7654322', linkState: 'claimed', claimedDiscordUserId: U(1), discordUserId: null });
    expect(syncJobIds).toEqual([]);
  });

  it('lists members by display name', () => {
    directory.create({ displayName: 'Misty' });
    directory.create({ displayName: 'ash' });
    directory.create({ displayName: 'Brock' });
    expect(directory.list().map((s) => s.displayName)).toEqual(['ash', 'Brock', 'Misty']);
  });
});

describe('claims (/link)', () => {
  it('records a claim on a new row named after the caller, which never links on its own', () => {
    const outcome = directory.claim({ userId: U(1), playerId: '7654321', displayName: 'Ash Ketchum' });
    expect(outcome).toEqual({ outcome: 'recorded' });
    const row = directory.list()[0]!;
    expect(row).toMatchObject({ displayName: 'Ash Ketchum', playerId: '7654321', linkState: 'claimed', claimedDiscordUserId: U(1), discordUserId: null });
    expect(directory.byDiscordUser(U(1))).toBeNull();
  });

  it('moves a claim, deleting the row the earlier claim created', () => {
    directory.claim({ userId: U(1), playerId: '7654321', displayName: 'Ash' });
    const existing = directory.create({ displayName: 'Ash (organizer)', playerId: '1112223' });
    directory.claim({ userId: U(1), playerId: '1112223', displayName: 'Ash' });
    expect(directory.list().map((s) => [s.playerId, s.linkState])).toEqual([['1112223', 'claimed']]);
    expect(directory.get(existing.id)?.claimedDiscordUserId).toBe(U(1));
  });

  it('refuses a player ID someone else holds or claims, and a caller who is linked', () => {
    directory.create({ displayName: 'Brock', playerId: '5550001', discordUserId: U(3) });
    directory.claim({ userId: U(1), playerId: '1112223', displayName: 'Ash' });
    expect(directory.claim({ userId: U(2), playerId: '1112223', displayName: 'Gary' })).toEqual({ outcome: 'taken' });
    expect(directory.claim({ userId: U(2), playerId: '5550001', displayName: 'Gary' })).toEqual({ outcome: 'taken' });
    expect(directory.claim({ userId: U(3), playerId: '9990001', displayName: 'Brock' })).toEqual({ outcome: 'already_linked', name: 'Brock' });
    expect(directory.claim({ userId: U(1), playerId: '12ab', displayName: 'Ash' })).toEqual({ outcome: 'invalid' });
  });

  it('confirms a claim into a link, and rejects one back to unlinked or away', () => {
    const organizerRow = directory.create({ displayName: 'Misty', playerId: '2220001' });
    directory.claim({ userId: U(2), playerId: '2220001', displayName: 'Misty' });
    const confirmed = directory.confirmClaim(organizerRow.id);
    expect(confirmed.staff).toMatchObject({ linkState: 'linked', discordUserId: U(2), claimedDiscordUserId: null });
    // Confirming only adds access: no removal sync.
    expect(confirmed.syncJobIds).toEqual([]);

    directory.claim({ userId: U(4), playerId: '4440001', displayName: 'Gary' });
    const claimRow = directory.list().find((s) => s.playerId === '4440001')!;
    expect(directory.rejectClaim(claimRow.id)).toBeNull();
    expect(directory.get(claimRow.id)).toBeNull();

    const kept = directory.create({ displayName: 'Erika', playerId: '6660001' });
    directory.claim({ userId: U(5), playerId: '6660001', displayName: 'Erika' });
    expect(directory.rejectClaim(kept.id)).toMatchObject({ linkState: 'unlinked', claimedDiscordUserId: null });
  });

  it('keeps a claim-created row that a day refers to, as unlinked', () => {
    directory = createDirectoryService({ db: database.db, clock, logger: silentLogger, onLinkChanged: () => [], isReferenced: () => true });
    directory.claim({ userId: U(4), playerId: '4440001', displayName: 'Gary' });
    const row = directory.list()[0]!;
    expect(directory.rejectClaim(row.id)).toMatchObject({ linkState: 'unlinked', playerId: '4440001' });
  });

  it('refuses to confirm without a claim, or onto a user linked meanwhile', () => {
    const plain = directory.create({ displayName: 'Plain' });
    expect(refusal(() => directory.confirmClaim(plain.id))).toBe('409 no_claim');
    expect(refusal(() => directory.rejectClaim(plain.id))).toBe('409 no_claim');
    const row = directory.create({ displayName: 'Sabrina', playerId: '8880001' });
    directory.claim({ userId: U(6), playerId: '8880001', displayName: 'Sabrina' });
    directory.create({ displayName: 'Other', discordUserId: U(6) });
    expect(refusal(() => directory.confirmClaim(row.id))).toBe('409 discord_user_taken');
  });
});
