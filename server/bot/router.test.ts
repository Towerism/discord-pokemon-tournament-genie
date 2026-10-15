import { describe, expect, it } from 'vitest';
import { recordingLogger } from '../../test/support/logger';
import type { InboundInteraction } from '../modules/discord/port';
import { createInteractionRouter } from './router';

const GUILD = '400000000000000001';

const interaction = (over: Partial<InboundInteraction> = {}): InboundInteraction => ({
  id: '500000000000000001',
  kind: 'command',
  name: 'penalty',
  guildId: GUILD,
  channelId: '600000000000000001',
  userId: '100000000000000001',
  options: {},
  memberRoleIds: [],
  userDisplayName: 'Ash',
  ...over,
});

function replies() {
  const sent: string[] = [];
  return { sent, reply: { ephemeral: async (text: string) => void sent.push(text) } };
}

describe('the interaction router', () => {
  it('drops and logs an interaction from another guild, without replying', async () => {
    const logger = recordingLogger();
    const router = createInteractionRouter({ boundGuildId: () => GUILD, logger, commands: {} });
    const { sent, reply } = replies();
    await router.route(interaction({ guildId: '400000000000000009' }), reply);
    expect(sent).toEqual([]);
    expect(logger.records).toEqual([
      expect.objectContaining({
        level: 'warn',
        msg: 'interaction_dropped',
        fields: { reason: 'foreign_guild', guildId: '400000000000000009', interactionId: '500000000000000001' },
      }),
    ]);
  });

  it('drops and logs a direct message', async () => {
    const logger = recordingLogger();
    const router = createInteractionRouter({ boundGuildId: () => GUILD, logger, commands: {} });
    const { sent, reply } = replies();
    await router.route(interaction({ guildId: null }), reply);
    expect(sent).toEqual([]);
    expect(logger.records[0]?.fields).toEqual({ reason: 'direct_message', guildId: null, interactionId: '500000000000000001' });
    expect(JSON.stringify(logger.records)).not.toContain('content');
  });

  it('drops everything while no guild is bound', async () => {
    const logger = recordingLogger();
    const router = createInteractionRouter({ boundGuildId: () => null, logger, commands: {} });
    const { sent, reply } = replies();
    await router.route(interaction(), reply);
    expect(sent).toEqual([]);
    expect(logger.records[0]?.fields).toMatchObject({ reason: 'foreign_guild' });
  });

  it("tells the caller a command isn't available when Genie doesn't have it", async () => {
    const router = createInteractionRouter({ boundGuildId: () => GUILD, logger: recordingLogger(), commands: {} });
    const { sent, reply } = replies();
    await router.route(interaction(), reply);
    expect(sent).toEqual(["This command isn't available."]);
  });

  it('runs a known command, and contains a handler error to its own interaction', async () => {
    const logger = recordingLogger();
    const handled: string[] = [];
    const router = createInteractionRouter({
      boundGuildId: () => GUILD,
      logger,
      commands: {
        broken: async () => {
          throw new Error('kaput');
        },
        fine: async (i) => {
          handled.push(i.id);
        },
      },
    });
    const first = replies();
    await router.route(interaction({ name: 'broken' }), first.reply);
    expect(first.sent).toEqual(['Something went wrong. Try again, or tell the organizer.']);
    expect(logger.records.find((r) => r.level === 'error')?.fields).toMatchObject({ command: 'broken' });

    const second = replies();
    await router.route(interaction({ name: 'fine', id: '500000000000000002' }), second.reply);
    expect(handled).toEqual(['500000000000000002']);
  });

  it('survives a failing error reply', async () => {
    const logger = recordingLogger();
    const router = createInteractionRouter({
      boundGuildId: () => GUILD,
      logger,
      commands: {
        broken: async () => {
          throw new Error('kaput');
        },
      },
    });
    const reply = {
      ephemeral: async () => {
        throw new Error('interaction expired');
      },
    };
    await expect(router.route(interaction({ name: 'broken' }), reply)).resolves.toBeUndefined();
    expect(logger.records.filter((r) => r.level === 'error')).toHaveLength(2);
  });
});
