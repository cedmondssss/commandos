import { z } from 'zod';

/**
 * Effect classes drive approval and undo semantics:
 * - read: no state change
 * - reversible_local: local change the undo journal can invert (move, rename, create, write-with-backup, trash)
 * - irreversible_local: local change that cannot be reliably inverted (empty trash, kill process, privileged command)
 * - external: leaves the machine or changes someone else's state (send, submit, pay, remote write, data egress)
 */
export const EffectClassSchema = z.enum(['read', 'reversible_local', 'irreversible_local', 'external']);
export type EffectClass = z.infer<typeof EffectClassSchema>;

export const EffectSchema = z.enum([
  'fs_read',
  'fs_write',
  'fs_delete',
  'ui_read',
  'ui_input',
  'app_control',
  'process_exec',
  'network_read',
  'external_send',
  'payment',
  'privileged',
  'remote_exec',
  'data_egress',
  'model_call',
  'memory_read',
  'memory_write',
]);
export type Effect = z.infer<typeof EffectSchema>;

export const RiskLevelSchema = z.enum(['none', 'low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RISK_ORDER: Readonly<Record<RiskLevel, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function maxRisk(...levels: Array<RiskLevel | undefined>): RiskLevel {
  let best: RiskLevel = 'none';
  for (const level of levels) {
    if (level && RISK_ORDER[level] > RISK_ORDER[best]) best = level;
  }
  return best;
}

const EFFECT_CLASS_ORDER: Readonly<Record<EffectClass, number>> = {
  read: 0,
  reversible_local: 1,
  irreversible_local: 2,
  external: 3,
};

export function maxEffectClass(...classes: EffectClass[]): EffectClass {
  let best: EffectClass = 'read';
  for (const c of classes) if (EFFECT_CLASS_ORDER[c] > EFFECT_CLASS_ORDER[best]) best = c;
  return best;
}

/**
 * Tool routing ladder: 1 direct APIs/filesystem, 2 Apple Events & Shortcuts,
 * 3 Accessibility, 4 screen capture + vision.
 */
export const ToolTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type ToolTier = z.infer<typeof ToolTierSchema>;

export const ToolDescriptorSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tier: ToolTierSchema,
  effectClass: EffectClassSchema,
  effects: z.array(EffectSchema),
  risk: RiskLevelSchema,
  idempotent: z.boolean(),
  defaultTimeoutMs: z.number().int().positive(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
