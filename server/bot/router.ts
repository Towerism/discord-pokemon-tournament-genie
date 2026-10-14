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
}) {
  const { boundGuildId, logger, commands, components = {} } = opts;
  const componentFor = (customId: string) => Object.entries(components).find(([prefix]) => customId.startsWith(prefix))?.[1];
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
      const isComponent = interaction.kind === 'component';
      const handler = isComponent ? componentFor(interaction.name) : Object.hasOwn(commands, interaction.name) ? commands[interaction.name] : undefined;
      try {
        if (!handler) {
          await reply.ephemeral(isComponent ? "This button isn't available." : "This command isn't available.");
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
