import { DiscordAPIError } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { DiscordAuthError, DiscordPermissionError, DiscordRequestError, DiscordUnavailableError } from '../../port';
import { translate } from './index';

/** A discord.js error for a card post, carrying the request it failed on as discord.js does. */
const apiError = (status: number, code: number, message: string) =>
  new DiscordAPIError({ code, message }, code, status, 'POST', 'https://discord.test/api/channels/1/messages', {
    body: { embeds: [{ fields: [{ name: "Competitor's player ID", value: '0012345' }, { name: 'Notes', value: 'secret note' }] }] },
  });

describe('translating Discord’s errors', () => {
  it('passes a refusal on with its status and code only, never the request it carried', () => {
    const original = apiError(404, 10003, 'Unknown Channel');
    expect(JSON.stringify(original.requestBody)).toContain('0012345');
    const err = translate(original);
    expect(err).toBeInstanceOf(DiscordRequestError);
    expect(err).toMatchObject({ status: 404, code: 10003 });
    expect(err).not.toHaveProperty('requestBody');
    const everything = JSON.stringify({ ...err, message: err.message });
    expect(everything).not.toContain('0012345');
    expect(everything).not.toContain('secret note');
  });

  it('keeps the auth, permission and unavailable mappings', () => {
    expect(translate(apiError(401, 0, '401: Unauthorized'))).toBeInstanceOf(DiscordAuthError);
    expect(translate(apiError(403, 50013, 'Missing Permissions'))).toBeInstanceOf(DiscordPermissionError);
    expect(translate(apiError(403, 50001, 'Missing Access'))).toBeInstanceOf(DiscordUnavailableError);
    expect(translate(apiError(502, 0, 'Bad Gateway'))).toBeInstanceOf(DiscordUnavailableError);
  });
});
