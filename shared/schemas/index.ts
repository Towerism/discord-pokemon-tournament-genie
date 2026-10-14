import { z } from '../zod';

/** A Discord ID: a decimal snowflake. */
export const snowflake = z.string().regex(/^\d{17,20}$/, 'Expected a Discord ID.');

export const unlockBody = z.object({ code: z.string().min(1).max(64) });

export const discordBody = z.object({
  botToken: z.string().trim().min(20).max(200),
  clientId: snowflake,
  clientSecret: z.string().trim().min(8).max(200),
});

export const guildBody = z.object({ guildId: snowflake });

export const rolesBody = z.object({ organizerRoleId: snowflake, headJudgeRoleId: snowflake });

export const allowlistBody = z.object({
  enabled: z.boolean(),
  userIds: z
    .array(snowflake)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Each user can be listed once.'),
});
