import { type AxElement, defaultSettings } from '@commandos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { RISKY_LABEL, uiPress, uiSetValue } from '../src/ui';
import type { ToolContext } from '../src/types';

const CHROME = 'com.google.Chrome';
const field: AxElement = { ref: '44:0.1', role: 'AXTextField', title: 'Repository confirmation', label: null, description: null, placeholder: null, value: '', identifier: 'confirm', subrole: null, enabled: true, focused: true, frame: null, actions: [], depth: 1, childCount: 0 };
const button: AxElement = { ...field, ref: '44:0.2', role: 'AXButton', title: 'Create repository', identifier: 'create' };
function harness(options: { disabled?: boolean; wrongFocus?: boolean; loseFocus?: boolean; failedReadBack?: boolean; native?: boolean } = {}) {
  let value = '';
    const current = () => ({ ...field, enabled: !options.disabled, value });
  const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (method === 'ax.find') return { elements: Object.keys((args.query ?? {}) as Record<string, unknown>).length ? [{ ...button, enabled: !options.disabled }] : [current(), { ...button, enabled: !options.disabled }] };
    if (method === 'ax.getValue') return { value: options.failedReadBack ? '' : value };
    if (method === 'ax.focused') return { bundleId: options.wrongFocus ? 'com.apple.TextEdit' : CHROME, element: options.wrongFocus ? { ...current(), ref: '99:0.1' } : current() };
    if (method === 'keyboard.press' && args.key === 'delete') value = '';
    if (method === 'keyboard.type') {
      if (options.loseFocus) throw Object.assign(new Error('focus changed'), { code: 'focus_changed' });
      value = String(args.text);
    }
    if (method === 'ax.fill') {
      if (options.wrongFocus) throw Object.assign(new Error('focus changed'), { code: 'focus_changed' });
      if (options.loseFocus) throw Object.assign(new Error('focus changed'), { code: 'focus_changed' });
      value = options.failedReadBack ? '' : String(args.value);
      return { value };
    }
    if (method === 'ax.click') return { clicked: true };
    if (method === 'ax.setValue') value = String(args.value);
    return { ok: true, value };
  });
  const record = vi.fn(async () => {});
  const context = { runId: 'test', taskId: 'input', signal: new AbortController().signal, dryRun: false, settings: defaultSettings(), helper: { call }, models: null, providers: { get: async () => { throw new Error('No providers'); } }, journal: { record }, artifactsDir: '/tmp', log: () => {}, progress: () => {} } as unknown as ToolContext;
  return { context, call, record };
}

describe('verified UI controls', () => {
  it('refuses to dispatch a press to a disabled control even with a valid bare ref', async () => {
    const h = harness({ disabled: true });
    await expect(uiPress.run({ bundleId: CHROME, target: { ref: button.ref }, expectLabel: 'Create repository' }, h.context)).rejects.toMatchObject({ code: 'disabled_element' });
    expect(h.call.mock.calls.some(([method]) => method === 'ax.press' || method === 'ax.click')).toBe(false);
  });

  it('labels a dispatched press as unconfirmed external effect', async () => {
    const h = harness();
    const output = await uiPress.run({ bundleId: CHROME, target: { ref: button.ref }, expectLabel: 'Create repository' }, h.context);
    expect(output.effectConfirmed).toBe(false);
    expect(RISKY_LABEL.test('Create repository')).toBe(true);
    expect(h.call).toHaveBeenCalledWith('ax.click', { bundleId: CHROME, role: 'AXButton', text: 'Create repository', identifier: 'create', expectLabel: 'Create repository' }, expect.objectContaining({ timeoutMs: 20_000 }));
  });

  it('uses target-bound per-character input for controlled Chromium fields and verifies it', async () => {
    const h = harness();
    const args = { bundleId: CHROME, target: { ref: field.ref }, value: 'owner/example' };
    const output = await uiSetValue.run(args, h.context);
    expect(output).toMatchObject({ via: 'keyboard', readBack: args.value, previous: '' });
    expect((await uiSetValue.verify!(args, output, h.context)).every((check) => check.ok)).toBe(true);
    expect(h.call).toHaveBeenCalledWith('ax.fill', { bundleId: CHROME, role: 'AXTextField', text: 'Repository confirmation', identifier: 'confirm', value: args.value }, expect.objectContaining({ timeoutMs: 20_000 }));
    expect(h.call.mock.calls.some(([method]) => method === 'ax.setValue')).toBe(false);
    expect(h.call.mock.calls.some(([method, args]) => method === 'keyboard.press' && ['return', 'enter'].includes(String(args.key)))).toBe(false);
    expect(h.record).toHaveBeenCalledWith({ kind: 'ax_restore_value', ref: field.ref, value: '' });
  });

  it('sends no keyboard events if focus is not on the resolved field', async () => {
    const h = harness({ wrongFocus: true });
    await expect(uiSetValue.run({ bundleId: CHROME, target: { ref: field.ref }, value: 'owner/example' }, h.context)).rejects.toMatchObject({ code: 'focus_changed' });
    expect(h.call.mock.calls.some(([method]) => method.startsWith('keyboard.'))).toBe(false);
  });

  it('propagates the native focus guard and retains undo for any partial input', async () => {
    const h = harness({ loseFocus: true });
    await expect(uiSetValue.run({ bundleId: CHROME, target: { ref: field.ref }, value: 'owner/example' }, h.context)).rejects.toMatchObject({ code: 'focus_changed' });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.call.mock.calls.filter(([method]) => method === 'ax.fill')).toHaveLength(1);
  });

  it('fails verification if the controlled field did not retain its value', async () => {
    const h = harness({ failedReadBack: true });
    const args = { bundleId: CHROME, target: { ref: field.ref }, value: 'owner/example' };
    const output = await uiSetValue.run(args, h.context);
    expect((await uiSetValue.verify!(args, output, h.context))[0]?.ok).toBe(false);
  });

  it('preserves direct Accessibility input for native applications', async () => {
    const h = harness();
    const args = { bundleId: 'com.apple.TextEdit', target: { ref: field.ref }, value: 'A native document' };
    const output = await uiSetValue.run(args, h.context);
    expect(output.via).toBe('accessibility');
    expect(output.readBack).toBe(args.value);
    expect(h.call.mock.calls.some(([method]) => method.startsWith('keyboard.'))).toBe(false);
  });
});
