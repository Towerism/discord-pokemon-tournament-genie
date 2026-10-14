import type { Outcome, PermissionName, RoleSpec, ThreadVariant } from './types.js';

/** An overwrite with its target resolved to a Discord ID; permissions stay as discord.js flag names. */
export type ResolvedOverwrite = { id: string; type: 'role' | 'member'; allow: string[]; deny: string[] };

export type TargetSpec = {
  name: string;
  /** Category overwrites the arranger (an administrator) writes; null = no category. */
  category: ResolvedOverwrite[] | null;
  /** R8: create the channel under the category through raw REST with no `permission_overwrites`. */
  rawUnderCategory: boolean;
  /** Overwrites the arranger puts on the channel at creation (write cases' `overwritesBefore`). */
  channelOverwrites: ResolvedOverwrite[];
};

export interface ArrangePort {
  setEveryoneBase(perms: PermissionName[]): Promise<void>;
  /** Creates the case's `spike-` roles (ledgered) and returns key → ID. */
  ensureRoles(roles: RoleSpec[]): Promise<Record<string, string>>;
  /** Sets the member's `spike-` roles to exactly these, removing leftovers (EC-5). */
  ensureMemberRoles(userId: string, roleIds: string[]): Promise<void>;
  createTarget(spec: TargetSpec): Promise<{ channelId: string; categoryId?: string }>;
  createParentCategory(name: string, overwrites: ResolvedOverwrite[]): Promise<string>;
  createThread(channelId: string, variant: ThreadVariant, memberIds: string[]): Promise<string>;
  seedMessage(targetId: string, emoji: string): Promise<string>;
  archiveThread(threadId: string): Promise<void>;
  /** Deletes the case's channels and roles right away (W3/W4's high role must not outlive its case). */
  teardownCase(): Promise<void>;
}

export interface WritePort {
  writeOverwrites(channelId: string, overwrites: ResolvedOverwrite[]): Promise<Outcome>;
  createWithOverwrites(spec: {
    kind: 'category' | 'channel';
    name: string;
    parentId?: string;
    overwrites: ResolvedOverwrite[];
  }): Promise<{ outcome: Outcome; id?: string }>;
  readOverwrites(channelId: string): Promise<ResolvedOverwrite[]>;
  libraryPermissions(targetId: string, userId: string): Promise<Record<PermissionName, boolean>>;
}

export interface ActPort {
  attempt(action: import('./types.js').Action, targetId: string, seededMessageId: string): Promise<Outcome>;
}

export interface ThreadStatePort {
  isArchived(threadId: string): Promise<boolean>;
}

export type RunnerPorts = { arrange: ArrangePort; write: WritePort; act: ActPort; threadState: ThreadStatePort };

export type RunContext = {
  guildId: string;
  runId: string;
  members: { subject: string; other: string; genie: string };
  /** Permission names on genie's managed role, recorded in each write case's context. */
  genieRolePermissions: string[];
};
