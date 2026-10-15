import { describe, expect, it } from 'vitest';
import { recordingLogger } from '../../test/support/logger';
import type { InboundInteraction, InteractionReply } from '../modules/discord/port';
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
  const choices: { name: string; value: string }[][] = [];
  const reply: InteractionReply = {
    ephemeral: async (text) => void sent.push(text),
    deferEphemeral: async () => undefined,
    showModal: async () => undefined,
    autocomplete: async (list) => void choices.push(list),
  };
  return { sent, choices, reply };
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
      ...replies().reply,
      ephemeral: async () => {
        throw new Error('interaction expired');
      },
    };
    await expect(router.route(interaction({ name: 'broken' }), reply)).resolves.toBeUndefined();
    expect(logger.records.filter((r) => r.level === 'error')).toHaveLength(2);
  });
});

describe('the interaction router for modals and autocomplete', () => {
  const PENALTY_MODAL = 'genie:penalty:';

  it('routes a modal submit by its custom-ID prefix', async () => {
    const seen: string[] = [];
    const router = createInteractionRouter({
      boundGuildId: () => GUILD,
      logger: recordingLogger(),
      commands: { 'genie:penalty:1:2:3': async () => void seen.push('command') },
      modals: { [PENALTY_MODAL]: async (i) => void seen.push(i.name) },
    });
    const { sent, reply } = replies();
    await router.route(interaction({ kind: 'modal', name: 'genie:penalty:1:2:3', fields: { notes: 'x' } }), reply);
    expect(seen).toEqual(['genie:penalty:1:2:3']);
    expect(sent).toEqual([]);
  });

  it("tells the caller a form isn't available when no modal handler matches", async () => {
    const router = createInteractionRouter({ boundGuildId: () => GUILD, logger: recordingLogger(), commands: {} });
    const { sent, reply } = replies();
    await router.route(interaction({ kind: 'modal', name: 'genie:unknown:1' }), reply);
    expect(sent).toEqual(["This form isn't available."]);
  });

  it('routes autocomplete by command name, and answers an empty list when it is unknown or fails', async () => {
    const router = createInteractionRouter({
      boundGuildId: () => GUILD,
      logger: recordingLogger(),
      commands: {},
      autocomplete: {
        penalty: async (_i, reply) => reply.autocomplete([{ name: 'LC', value: '7' }]),
        broken: async () => {
          throw new Error('kaput');
        },
      },
    });
    const known = replies();
    await router.route(interaction({ kind: 'autocomplete', name: 'penalty', focused: { name: 'event', value: 'l' } }), known.reply);
    expect(known.choices).toEqual([[{ name: 'LC', value: '7' }]]);
    for (const name of ['unknown', 'broken']) {
      const r = replies();
      await router.route(interaction({ kind: 'autocomplete', name }), r.reply);
      expect(r.choices).toEqual([[]]);
      expect(r.sent).toEqual([]);
    }
  });

  it('drops a modal submit and an autocomplete from another guild or a DM, without answering', async () => {
    const logger = recordingLogger();
    const router = createInteractionRouter({
      boundGuildId: () => GUILD,
      logger,
      commands: {},
      modals: { [PENALTY_MODAL]: async () => expect.unreachable() },
      autocomplete: { penalty: async () => expect.unreachable() },
    });
    for (const guildId of ['400000000000000009', null]) {
      for (const over of [{ kind: 'modal', name: 'genie:penalty:1:2:3' }, { kind: 'autocomplete', name: 'penalty' }] as const) {
        const r = replies();
        await router.route(interaction({ ...over, guildId }), r.reply);
        expect(r.sent).toEqual([]);
        expect(r.choices).toEqual([]);
      }
    }
    expect(logger.records.filter((r) => r.msg === 'interaction_dropped')).toHaveLength(4);
  });
});
