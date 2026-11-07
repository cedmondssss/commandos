import type { AnyTool, ToolRegistry } from '@commandos/tools';
import type { FunctionTool } from 'openai/resources/responses/responses';
import { z } from 'zod';

type Json = Record<string, unknown>;

const STRICT_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);

class Unsupported extends Error {}

function nullable(schema: Json): Json {
  if (Array.isArray(schema.anyOf)) {
    const anyOf = schema.anyOf as Json[];
    return anyOf.some((s) => s.type === 'null') ? schema : { ...schema, anyOf: [...anyOf, { type: 'null' }] };
  }
  if (typeof schema.type === 'string') {
    const out: Json = { ...schema, type: [schema.type, 'null'] };
    if (Array.isArray(schema.enum)) out.enum = [...(schema.enum as unknown[]), null];
    return out;
  }
  if (Array.isArray(schema.type)) {
    return (schema.type as string[]).includes('null') ? schema : { ...schema, type: [...(schema.type as string[]), 'null'] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

/**
 * Converts a JSON Schema to OpenAI strict-mode form: every object closes with
 * additionalProperties:false and lists all properties as required (optional ones become
 * nullable). Throws Unsupported for records, recursion or untyped values.
 */
export function strictify(schema: Json): Json {
  if (schema.$ref || schema.$defs || schema.propertyNames || schema.prefixItems) throw new Unsupported('ref/record/tuple');
  if (Object.keys(schema).length === 0 || (schema.type === undefined && !schema.anyOf && !schema.oneOf && !schema.enum && schema.const === undefined)) {
    throw new Unsupported('untyped value');
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['$schema', 'default', 'examples', 'title', 'id', '$id', 'readOnly', 'writeOnly'].includes(k)) continue;
    if (k === 'format' && !STRICT_FORMATS.has(String(v))) continue;
    out[k] = v;
  }
  if (Array.isArray(schema.oneOf)) {
    delete out.oneOf;
    out.anyOf = (schema.oneOf as Json[]).map(strictify);
  }
  if (Array.isArray(schema.anyOf)) out.anyOf = (schema.anyOf as Json[]).map(strictify);
  if (Array.isArray(schema.allOf)) {
    if ((schema.allOf as Json[]).length !== 1) throw new Unsupported('allOf');
    return strictify({ ...(schema.allOf as Json[])[0], ...(schema.description ? { description: schema.description } : {}) });
  }
  const isObject = schema.type === 'object' || (Array.isArray(schema.type) && (schema.type as string[]).includes('object')) || schema.properties;
  if (isObject) {
    if (schema.additionalProperties && schema.additionalProperties !== false) throw new Unsupported('record');
    const props = (schema.properties ?? {}) as Record<string, Json>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const properties: Record<string, Json> = {};
    for (const [name, p] of Object.entries(props)) {
      const strict = strictify(p);
      properties[name] = required.has(name) ? strict : nullable(strict);
    }
    out.type = 'object';
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  if (schema.type === 'array' || schema.items) {
    if (!schema.items || typeof schema.items !== 'object') throw new Unsupported('untyped array');
    out.items = strictify(schema.items as Json);
  }
  return out;
}

/** Deeply removes null values, so optional/nullable strict args fall back to Zod defaults. */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== null) out[k] = stripNulls(x);
    return out;
  }
  return v;
}

export function functionNameFor(toolId: string): string {
  return toolId.replace(/[^A-Za-z0-9_-]/g, '_');
}

function argsSchema(tool: AnyTool): { schema: Json; strict: boolean } {
  const raw = z.toJSONSchema(tool.args, { io: 'input', unrepresentable: 'any' }) as Json;
  try {
    return { schema: strictify(raw), strict: true };
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    const { $schema: _s, ...rest } = raw;
    return { schema: rest, strict: false };
  }
}

const BIND_SCHEMA = {
  type: 'array',
  description: 'Pipe outputs of tasks listed in depends_on into this task’s arguments.',
  items: {
    type: 'object',
    properties: {
      arg: { type: 'string', description: 'argument path, e.g. "items" or "paths.0"' },
      from: { type: 'string', description: 'source, e.g. "t1.output.files" or "t1.output.files[*].path"' },
    },
    required: ['arg', 'from'],
    additionalProperties: false,
  },
};

const FINISH_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked', 'needs_user'] },
    summary: { type: 'string', description: 'one sentence' },
    answer_from: {
      type: ['string', 'null'],
      description: 'When the user asked a question and a task output is the answer, its path (e.g. "t2.output.answer"): the user is shown that output, so no turn is needed to read it. Otherwise null.',
    },
  },
  required: ['outcome', 'summary', 'answer_from'],
  additionalProperties: false,
};

export interface PlannerTools {
  /** function definitions sent to the model: schedule + finish */
  tools: FunctionTool[];
  /** tool name used inside schedule (e.g. fs_mkdir) → registry tool id (fs.mkdir) */
  toolIds: Map<string, string>;
  /** tool names whose arguments travel as args_json (schemas OpenAI strict mode cannot express) */
  jsonArgs: Set<string>;
}

/** One anyOf variant of a scheduled task's `call`: the tool name plus its typed arguments. */
function callVariant(tool: AnyTool): { name: string; strict: boolean; variant: Json } {
  const name = functionNameFor(tool.id);
  const { schema, strict } = argsSchema(tool);
  const output = JSON.stringify(z.toJSONSchema(tool.output, { io: 'output', unrepresentable: 'any' }));
  const description = `${tool.description} [tier ${tool.tier}; ${typeof tool.effectClass === 'string' ? tool.effectClass : 'varies'}] Returns: ${output.length > 1800 ? `${output.slice(0, 1800)}…` : output}`;
  if (strict) {
    return {
      name,
      strict,
      variant: { type: 'object', description, properties: { tool: { type: 'string', enum: [name] }, args: schema }, required: ['tool', 'args'], additionalProperties: false },
    };
  }
  return {
    name,
    strict,
    variant: {
      type: 'object',
      description: `${description} Arguments go in args_json: a JSON object string matching ${JSON.stringify(schema)}`,
      properties: { tool: { type: 'string', enum: [name] }, args_json: { type: 'string' } },
      required: ['tool', 'args_json'],
      additionalProperties: false,
    },
  };
}

const cache = new WeakMap<ToolRegistry, PlannerTools>();

/**
 * The STANDARD planner acts through one batch function. GPT-6 models emit a single function call
 * per response, so a call per tool would cost a model round trip per step; `schedule` carries a
 * whole dependency chain (task_id, depends_on, bind) plus an optional finish in one call, and the
 * runtime dispatches each task as soon as its JSON object finishes streaming.
 */
export function plannerTools(registry: ToolRegistry): PlannerTools {
  const cached = cache.get(registry);
  if (cached) return cached;
  const variants = registry.list().map((tool) => ({ toolId: tool.id, ...callVariant(tool) }));
  const schedule: FunctionTool = {
    type: 'function',
    name: 'schedule',
    description:
      'Schedule tasks. Each task is one tool call; it runs as soon as the tasks in its depends_on succeed, and tasks that do not depend on each other run concurrently. Put every step you already know into one call.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'string', description: 'unique id for this task across the whole run, e.g. t1, t2' },
              title: { type: 'string', description: 'short human-readable step title' },
              depends_on: { type: 'array', items: { type: 'string' }, description: 'task ids that must succeed first' },
              bind: BIND_SCHEMA,
              call: { anyOf: variants.map((v) => v.variant) },
            },
            required: ['task_id', 'title', 'depends_on', 'bind', 'call'],
            additionalProperties: false,
          },
        },
        finish: {
          anyOf: [{ ...FINISH_SCHEMA, description: 'Set when these tasks complete the goal (CommandOS still verifies them and returns any failure to you); null when you need to see their results first.' }, { type: 'null' }],
        },
      },
      required: ['tasks', 'finish'],
      additionalProperties: false,
    },
  };
  const finish: FunctionTool = {
    type: 'function',
    name: 'finish',
    description: 'End the run when no further tasks are needed: the goal is complete, or you cannot continue. Summarize only what tool results confirmed.',
    strict: true,
    parameters: FINISH_SCHEMA,
  };
  const out: PlannerTools = {
    tools: [schedule, finish],
    toolIds: new Map(variants.map((v) => [v.name, v.toolId])),
    jsonArgs: new Set(variants.filter((v) => !v.strict).map((v) => v.name)),
  };
  cache.set(registry, out);
  return out;
}
