import type { Logger } from '@towerism/selfhost-kit';
import type { InboundInteraction, InteractionReply } from '../modules/discord/port';

export type CommandHandler = (interaction: InboundInteraction, reply: InteractionReply) => Promise<void>;

/**
 * The Discord-side twin of the API routes (architecture §3). Only the bound guild is served: anything else,
 * DMs included, is dropped and logged (§4.1). Each interaction's errors stay with that interaction.
 */
export function createInteractionRouter(opts: {
  boundGuildId: () => string | null;
  logger: Logger;
  commands: Readonly<Record<string, CommandHandler>>;
  /** Buttons and other components, by custom-ID prefix (`genie:day-sync:`). */
  components?: Readonly<Record<string, CommandHandler>>;
  /** Modal submits, by custom-ID prefix (`genie:penalty:`). */
  modals?: Readonly<Record<string, CommandHandler>>;
  /** Autocomplete, by command name. */
  autocomplete?: Readonly<Record<string, CommandHandler>>;
}) {
  const { boundGuildId, logger, commands, components = {}, modals = {}, autocomplete = {} } = opts;
  const byPrefix = (table: Readonly<Record<string, CommandHandler>>, customId: string) => Object.entries(table).find(([prefix]) => customId.startsWith(prefix))?.[1];
  const byName = (table: Readonly<Record<string, CommandHandler>>, name: string) => (Object.hasOwn(table, name) ? table[name] : undefined);
  const unavailable = { command: "This command isn't available.", component: "This button isn't available.", modal: "This form isn't available." } as const;

  return {
    async route(interaction: InboundInteraction, reply: InteractionReply): Promise<void> {
      const bound = boundGuildId();
      if (interaction.guildId === null || interaction.guildId !== bound) {
        logger.warn('interaction_dropped', {
          reason: interaction.guildId === null ? 'direct_message' : 'foreign_guild',
          guildId: interaction.guildId,
          interactionId: interaction.id,
        });
        return;
      }
      if (interaction.kind === 'autocomplete') {
        // Discord accepts only choices here; a failure answers none rather than an error message.
        const handler = byName(autocomplete, interaction.name);
        try {
          if (handler) return await handler(interaction, reply);
        } catch (err) {
          logger.error(`Autocomplete ${interaction.name} failed.`, { command: interaction.name, interactionId: interaction.id, err });
        }
        await reply.autocomplete([]).catch((err: unknown) => logger.error('Could not send the empty choices.', { interactionId: interaction.id, err }));
        return;
      }
      const handler =
        interaction.kind === 'component' ? byPrefix(components, interaction.name) : interaction.kind === 'modal' ? byPrefix(modals, interaction.name) : byName(commands, interaction.name);
      try {
        if (!handler) {
          await reply.ephemeral(unavailable[interaction.kind]);
          return;
        }
        await handler(interaction, reply);
      } catch (err) {
        logger.error(`Interaction ${interaction.name} failed.`, { command: interaction.name, interactionId: interaction.id, err });
        try {
          await reply.ephemeral('Something went wrong. Try again, or tell the organizer.');
        } catch (replyErr) {
          logger.error('Could not send the error reply.', { interactionId: interaction.id, err: replyErr });
        }
      }
    },
  };
}
