import { ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, commands, modalFor, parseSubmission, PENALTIES, SEVERITIES, startMessage } from '../../src/s2/forms.js';

type Json = { type: number; component?: { type: number; options?: { value: string }[]; custom_id?: string }; components?: Json[] };

describe('commands', () => {
  it('Variant A takes round, category, severity and penalty as options', () => {
    const a = commands().find((c) => c.name === 'spike-penalty-a')!;
    expect(a.options!.map((o) => o.name)).toEqual(['round', 'category', 'severity', 'penalty']);
    const choices = (name: string) => (a.options!.find((o) => o.name === name) as { choices: { value: string }[] }).choices.map((c) => c.value);
    expect(choices('category')).toEqual(CATEGORIES);
    expect(choices('severity')).toEqual(SEVERITIES);
    expect(choices('penalty')).toEqual(PENALTIES);
  });

  it('Variant B takes only round', () => {
    const b = commands().find((c) => c.name === 'spike-penalty-b')!;
    expect(b.options!.map((o) => o.name)).toEqual(['round']);
  });
});

describe('modals', () => {
  it('Variant B has exactly five top-level Labels: three selects with the §6.4 lists, two text inputs', () => {
    const m = modalFor('B', 'x').toJSON() as { components: Json[] };
    expect(m.components).toHaveLength(5);
    expect(m.components.every((c) => c.type === ComponentType.Label)).toBe(true);
    const selects = m.components.filter((c) => c.component?.type === ComponentType.StringSelect);
    expect(selects.map((s) => s.component!.options!.map((o) => o.value))).toEqual([CATEGORIES, SEVERITIES, PENALTIES]);
    expect(m.components.filter((c) => c.component?.type === ComponentType.TextInput)).toHaveLength(2);
  });

  it('Variant A has exactly two top-level Labels wrapping text inputs', () => {
    const m = modalFor('A', 'x').toJSON() as { components: Json[] };
    expect(m.components).toHaveLength(2);
    expect(m.components.every((c) => c.type === ComponentType.Label && c.component?.type === ComponentType.TextInput)).toBe(true);
  });
});

describe('startMessage', () => {
  it('offers a Start A and a Start B button', () => {
    const msg = startMessage('pixel-8');
    const row = msg.components[0]!.toJSON() as { components: { custom_id: string; label: string }[] };
    expect(row.components.map((b) => b.custom_id)).toEqual(['s2:start:A', 's2:start:B']);
    expect(msg.content).toContain('pixel-8');
  });
});

describe('parseSubmission', () => {
  it('accepts a digits-only player ID', () => {
    expect(parseSubmission({ playerId: '1234567', notes: 'late deck check' })).toEqual({ ok: true, playerId: '1234567' });
  });

  it.each(['12a4', '', ' 123', '12 34'])('rejects %j as invalid_player_id', (playerId) => {
    expect(parseSubmission({ playerId, notes: '' })).toEqual({ ok: false, outcome: 'invalid_player_id' });
  });
});
