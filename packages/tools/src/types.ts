import type {
  CheckResult,
  Effect,
  EffectClass,
  RiskLevel,
  Settings,
  ToolDescriptor,
  ToolTier,
  UndoOp,
} from '@commandos/contracts';
import type { ModelGateway } from '@commandos/providers';
import type { z } from 'zod';
import type { HelperClient } from './helper/client';

export type EgressKind = 'content' | 'images' | 'files';

export interface ToolLogger {
  (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

/**
 * Lazily-constructed provider clients (Daytona, Anchor, memory…). Each getter throws a
 * MissingCredentialError when the provider is not configured.
 */
export interface ProviderAccess {
  get<T>(name: string): Promise<T>;
}

export interface ToolContext {
  runId: string;
  taskId: string;
  signal: AbortSignal;
  dryRun: boolean;
  settings: Settings;
  helper: HelperClient;
  /** null when no OpenAI credential is configured */
  models: ModelGateway | null;
  providers: ProviderAccess;
  journal: { record(op: UndoOp): Promise<void> };
  /** per-run directory for artifacts (reports, captures, backups) */
  artifactsDir: string;
  log: ToolLogger;
  /** short progress line shown live in the activity log */
  progress(text: string): void;
}

export interface PathAccess {
  read: string[];
  write: string[];
}

export interface ToolPreview {
  summary: string;
  details: string[];
}

export interface ToolDefinition<A extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: string;
  title: string;
  /** Written for the planner model: what it does, when to use it, what it returns. */
  description: string;
  tier: ToolTier;
  args: A;
  output: O;
  effectClass: EffectClass | ((args: z.output<A>) => EffectClass);
  effects: Effect[];
  risk: RiskLevel | ((args: z.output<A>) => RiskLevel);
  idempotent: boolean;
  /** Only tools that actually record inverse operations may advertise journal undo. */
  undo?: 'journaled';
  defaultTimeoutMs: number;
  /** data that leaves the machine, checked against consent settings */
  egress?: EgressKind;
  /** filesystem paths touched, checked against allowed/denied roots */
  paths?(args: z.output<A>): PathAccess;
  /** number of items changed, for the reversible auto-approve threshold */
  itemCount?(args: z.output<A>): number;
  /** who an external send goes to; sends only to the user's own address skip the prompt */
  recipients?(args: z.output<A>): string[];
  /** lock keys; tasks sharing a key never run concurrently */
  resources?(args: z.output<A>): string[];
  preview?(args: z.output<A>): ToolPreview;
  run(args: z.output<A>, ctx: ToolContext): Promise<z.output<O>>;
  /** built-in postcondition checks against the real system state */
  verify?(args: z.output<A>, output: z.output<O>, ctx: ToolContext): Promise<CheckResult[]>;
  /** compact form of the output for model context and the activity log */
  summarize?(output: z.output<O>): unknown;
  /**
   * Deterministic fallbacks for a failed call, tried in order before any model-based repair
   * (e.g. retry a form fill by visible label when CSS selectors no longer match).
   */
  alternatives?(args: z.output<A>, error: { code?: string; message: string }): Array<{ args: z.input<A>; label: string }>;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry
export type AnyTool = ToolDefinition<any, any>;

export function defineTool<A extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<A, O>): ToolDefinition<A, O> {
  return def;
}

export function resolveEffectClass(tool: AnyTool, args: unknown): EffectClass {
  return typeof tool.effectClass === 'function' ? tool.effectClass(args) : tool.effectClass;
}

export function resolveRisk(tool: AnyTool, args: unknown): RiskLevel {
  return typeof tool.risk === 'function' ? tool.risk(args) : tool.risk;
}

export function describeTool(tool: AnyTool): ToolDescriptor {
  return {
    id: tool.id,
    title: tool.title,
    description: tool.description,
    tier: tool.tier,
    effectClass: typeof tool.effectClass === 'function' ? 'reversible_local' : tool.effectClass,
    effects: tool.effects,
    risk: typeof tool.risk === 'function' ? 'medium' : tool.risk,
    idempotent: tool.idempotent,
    defaultTimeoutMs: tool.defaultTimeoutMs,
  };
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
