import { describe, expect, it } from 'vitest';
import {
  AudioChunkSchema,
  BindingSchema,
  defaultSettings,
  HelperMethods,
  maxRisk,
  PlanSchema,
  RunEventSchema,
  SettingsSchema,
  TaskSpecSchema,
} from '../src';

describe('task contracts', () => {
  it('applies defaults to task specs', () => {
    const t = TaskSpecSchema.parse({ id: 'find', tool: 'screenshots.find', args: {} });
    expect(t.dependsOn).toEqual([]);
    expect(t.bind).toEqual([]);
    expect(t.postconditions).toEqual([]);
  });

  it('rejects task ids that bindings cannot reference', () => {
    expect(TaskSpecSchema.safeParse({ id: '1abc', tool: 'x', args: {} }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ id: 'a b', tool: 'x', args: {} }).success).toBe(false);
  });

  it('validates binding syntax', () => {
    expect(BindingSchema.safeParse({ arg: 'items', from: 'name.output.items' }).success).toBe(true);
    expect(BindingSchema.safeParse({ arg: 'paths.0', from: 'organize.output.destinationDir' }).success).toBe(true);
    expect(BindingSchema.safeParse({ arg: 'images', from: 'find.output.files[*].path' }).success).toBe(true);
    expect(BindingSchema.safeParse({ arg: 'x', from: 'find.files' }).success).toBe(false);
    expect(BindingSchema.safeParse({ arg: '0bad', from: 'find.output' }).success).toBe(false);
    // models often write array indexes in bracket form
    expect(BindingSchema.parse({ arg: 'where[0].value', from: 't1.output.items' }).arg).toBe('where.0.value');
    expect(BindingSchema.safeParse({ arg: 'where[*].value', from: 't1.output.items' }).success).toBe(false);
  });

  it('requires at least one task in a plan', () => {
    expect(PlanSchema.safeParse({ goal: 'g', tasks: [] }).success).toBe(false);
  });
});

describe('events and settings', () => {
  it('parses run events by discriminant', () => {
    const e = RunEventSchema.parse({ type: 'task_state', runId: 'run_1', at: 1, taskId: 't1', state: 'running', attempt: 1 });
    expect(e.type).toBe('task_state');
    expect(RunEventSchema.safeParse({ type: 'task_state', runId: 'run_1', at: 1, taskId: 't1', state: 'bogus', attempt: 1 }).success).toBe(false);
  });

  it('default settings are valid and use the OpenAI GPT-6 router', () => {
    const s = SettingsSchema.parse(defaultSettings());
    expect(s.models).toEqual({ fast: 'gpt-6-luna', main: 'gpt-6.1-sol', deep: 'gpt-6-astra' });
    expect(s.imagesToModel).toBe('ask');
  });

  it('accepts only even-length PCM chunks up to 64 KiB', () => {
    expect(AudioChunkSchema.safeParse(new Uint8Array(3200)).success).toBe(true);
    expect(AudioChunkSchema.safeParse(new Uint8Array(3)).success).toBe(false);
    expect(AudioChunkSchema.safeParse(new Uint8Array(70_000)).success).toBe(false);
    expect(AudioChunkSchema.safeParse('not bytes').success).toBe(false);
  });

  it('maxRisk picks the highest level', () => {
    expect(maxRisk('low', undefined, 'high', 'medium')).toBe('high');
    expect(maxRisk()).toBe('none');
  });

  it('helper contract lists every native method', () => {
    expect(Object.keys(HelperMethods).sort()).toEqual(
      [
        'ping',
        'permissions.status',
        'permissions.request',
        'apps.list',
        'apps.frontmost',
        'apps.info',
        'apps.launch',
        'apps.activate',
        'apps.quit',
        'workspace.open',
        'workspace.reveal',
        'spotlight.query',
        'vision.ocr',
        'image.info',
        'screen.capture',
        'ax.tree',
        'ax.find',
        'ax.press',
        'ax.setValue',
        'ax.getValue',
        'ax.focus',
        'ax.focused',
        'ax.enableWeb',
        'ax.webText',
        'keyboard.type',
        'keyboard.press',
        'mouse.click',
        'osa.run',
        'fs.trash',
        'keychain.get',
        'keychain.set',
        'keychain.delete',
        'keychain.list',
      ].sort(),
    );
  });
});
