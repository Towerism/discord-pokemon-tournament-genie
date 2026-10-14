import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

/** §6.4's clipboard lists. */
export const CATEGORIES = ['Game Play', 'Deck/Team', 'Pace of Play', 'Procedural', 'Unsporting', 'Cheating'];
export const SEVERITIES = ['Minor', 'Major', 'Severe'];
export const PENALTIES = ['Warning', 'DPC', 'QPC', 'GL', 'DQ'];

export type Variant = 'A' | 'B';

const choices = (xs: string[]) => xs.map((x) => ({ name: x, value: x }));

export function commands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const round = (b: SlashCommandBuilder) =>
    b.addIntegerOption((o) => o.setName('round').setDescription('Round').setMinValue(1).setRequired(true));
  const a = round(new SlashCommandBuilder().setName('spike-penalty-a').setDescription('S2 Variant A: options + 2-field modal'))
    .addStringOption((o) => o.setName('category').setDescription('Category').setRequired(true).addChoices(...choices(CATEGORIES)))
    .addStringOption((o) => o.setName('severity').setDescription('Severity').setRequired(true).addChoices(...choices(SEVERITIES)))
    .addStringOption((o) => o.setName('penalty').setDescription('Penalty').setRequired(true).addChoices(...choices(PENALTIES)));
  const b = round(new SlashCommandBuilder().setName('spike-penalty-b').setDescription('S2 Variant B: selects in the modal'));
  return [a.toJSON(), b.toJSON()];
}

const textLabel = (id: string, label: string, style: TextInputStyle, required: boolean) =>
  new LabelBuilder().setLabel(label).setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required));

const selectLabel = (id: string, label: string, options: string[]) =>
  new LabelBuilder()
    .setLabel(label)
    .setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId(id).addOptions(options.map((o) => ({ label: o, value: o }))),
    );

export function modalFor(variant: Variant, customId: string): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(`Penalty (Variant ${variant})`);
  if (variant === 'B') {
    modal.addLabelComponents(
      selectLabel('category', 'Category', CATEGORIES),
      selectLabel('severity', 'Severity', SEVERITIES),
      selectLabel('penalty', 'Penalty', PENALTIES),
    );
  }
  modal.addLabelComponents(
    textLabel('playerId', "Competitor's player ID", TextInputStyle.Short, true),
    textLabel('notes', 'Notes', TextInputStyle.Paragraph, false),
  );
  return modal;
}

export function startMessage(device: string) {
  return {
    content: `S2 timing on **${device}**. Tap Start, then run the matching command and submit the form.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('s2:start:A').setLabel('Start A').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('s2:start:B').setLabel('Start B').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

export function parseSubmission(fields: { playerId: string; notes: string }):
  | { ok: true; playerId: string }
  | { ok: false; outcome: 'invalid_player_id' } {
  return /^\d+$/.test(fields.playerId) ? { ok: true, playerId: fields.playerId } : { ok: false, outcome: 'invalid_player_id' };
}
