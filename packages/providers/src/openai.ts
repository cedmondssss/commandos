import type { ModelCall, ModelTier, ReasoningEffort, Settings } from '@commandos/contracts';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { Response, ResponseInput, ResponseStreamEvent, Tool } from 'openai/resources/responses/responses';
import type { z } from 'zod';

export interface ModelCallContext {
  runId?: string;
  signal?: AbortSignal;
}

export type ModelCallListener = (call: ModelCall, ctx: ModelCallContext) => void;

export type ServiceTier = Settings['serviceTier'];

export interface ModelGatewayOptions {
  apiKey: string;
  models: Settings['models'];
  efforts: Settings['efforts'];
  /** 'fast' = OpenAI Fast mode: lower, steadier latency at a per-token premium */
  serviceTier?: ServiceTier;
  baseURL?: string;
  onCall?: ModelCallListener;
  timeoutMs?: number;
}

export interface ParseRequest<S extends z.ZodType> extends ModelCallContext {
  tier: ModelTier;
  purpose: string;
  instructions: string;
  input: string | ResponseInput;
  schema: S;
  schemaName: string;
  effort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** Stable key so requests sharing a prompt prefix land on the same prompt cache. */
  cacheKey?: string;
  verbosity?: 'low' | 'medium' | 'high';
  /** overrides the gateway's service tier for this call */
  serviceTier?: ServiceTier;
  /**
   * Hedge: send an identical second request after this many ms (0 = at once) and keep whichever
   * answers first; the other is cancelled. For small latency-critical calls such as routing.
   */
  hedgeAfterMs?: number;
}

/**
 * Runs `attempt`, and a second identical attempt after `afterMs` (or as soon as the first fails);
 * the first success wins and the other attempt is aborted. Measured on gpt-6-luna router calls
 * (16 requests in pairs): single p50 3.9 s / max 10.8 s, best of two p50 3.6 s / max 5.1 s, so
 * latency spikes hit individual requests, not the whole API.
 */
export function hedged<T>(attempt: (signal: AbortSignal, index: number) => Promise<T>, opts: { afterMs: number; signal?: AbortSignal }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let pending = 0;
    let settled = false;
    let firstError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      settled = true;
      if (timer) clearTimeout(timer);
    };
    const start = () => {
      const index = controllers.length;
      const controller = new AbortController();
      controllers.push(controller);
      pending++;
      attempt(opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal, index).then(
        (value) => {
          pending--;
          if (settled) return;
          settle();
          for (const [j, other] of controllers.entries()) if (j !== index) other.abort(new Error('hedged: the other request answered first'));
          resolve(value);
        },
        (error: unknown) => {
          pending--;
          if (settled) return;
          firstError ??= error;
          if (opts.signal?.aborted) {
            settle();
            reject(error);
          } else if (controllers.length < 2) {
            if (timer) clearTimeout(timer);
            start();
          } else if (pending === 0) {
            settle();
            reject(firstError);
          }
        },
      );
    };
    start();
    timer = setTimeout(() => {
      if (!settled && controllers.length < 2) start();
    }, opts.afterMs);
  });
}

export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly refusal?: string,
  ) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

/** Efforts each model family is documented to accept; unsupported values are clamped. */
function clampEffort(model: string, effort: ReasoningEffort): ReasoningEffort {
  const noNone = /^gpt-6\.1-sol|^gpt-6-astra/.test(model);
  if (noNone && (effort === 'none' || effort === 'minimal')) return 'low';
  return effort;
}

function errorMessage(e: unknown, signal?: AbortSignal): string {
  // a deliberate abort (stop, or a discarded speculative plan) is not a provider failure
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : typeof signal.reason === 'string' ? signal.reason : '';
    return `cancelled${reason ? `: ${reason}` : ''}`;
  }
  if (e instanceof OpenAI.APIError) return `${e.status ?? ''} ${e.message}`.trim();
  return e instanceof Error ? e.message : String(e);
}

/**
 * Single entry point for OpenAI calls. Routes by tier (fast/main/deep), records latency and
 * token usage for every call (success or failure) so metrics can count model calls per run.
 */
export class ModelGateway {
  readonly client: OpenAI;
  private models: Settings['models'];
  private efforts: Settings['efforts'];
  private serviceTier: ServiceTier;
  private listeners = new Set<ModelCallListener>();

  constructor(opts: ModelGatewayOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      maxRetries: 2,
      timeout: opts.timeoutMs ?? 120_000,
    });
    this.models = opts.models;
    this.efforts = opts.efforts;
    this.serviceTier = opts.serviceTier ?? 'default';
    if (opts.onCall) this.listeners.add(opts.onCall);
  }

  configure(models: Settings['models'], efforts: Settings['efforts'], serviceTier?: ServiceTier): void {
    this.models = models;
    this.efforts = efforts;
    if (serviceTier) this.serviceTier = serviceTier;
  }

  /** request field for the service tier; omitted for 'default' so the project setting applies */
  private tierParam(override?: ServiceTier): { service_tier?: 'fast' } {
    return (override ?? this.serviceTier) === 'fast' ? { service_tier: 'fast' } : {};
  }

  onCall(listener: ModelCallListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  effortFor(tier: ModelTier, override?: ReasoningEffort): ReasoningEffort {
    return clampEffort(this.models[tier], override ?? this.efforts[tier]);
  }

  emit(call: ModelCall, ctx: ModelCallContext): void {
    for (const l of this.listeners) {
      try {
        l(call, ctx);
      } catch {
        // listeners must not break model calls
      }
    }
  }

  /** Structured output via the Responses API; the result is validated by the Zod schema. */
  async parse<S extends z.ZodType>(req: ParseRequest<S>): Promise<{ data: z.output<S>; call: ModelCall }> {
    if (req.hedgeAfterMs === undefined) return this.parseOnce(req);
    return hedged((signal, i) => this.parseOnce({ ...req, signal, ...(i > 0 ? { purpose: `${req.purpose}_hedge` } : {}) }), { afterMs: req.hedgeAfterMs, signal: req.signal });
  }

  private async parseOnce<S extends z.ZodType>(req: ParseRequest<S>): Promise<{ data: z.output<S>; call: ModelCall }> {
    const model = this.modelFor(req.tier);
    const effort = this.effortFor(req.tier, req.effort);
    const started = performance.now();
    const base: Omit<ModelCall, 'latencyMs' | 'ok'> = { purpose: req.purpose, tier: req.tier, model, effort };
    try {
      const response = await this.client.responses.parse(
        {
          model,
          instructions: req.instructions,
          input: req.input,
          reasoning: { effort },
          text: {
            format: zodTextFormat(req.schema, req.schemaName),
            ...(req.verbosity ? { verbosity: req.verbosity } : {}),
          },
          store: false,
          ...this.tierParam(req.serviceTier),
          ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
          ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
        },
        { signal: req.signal },
      );
      const usage = response.usage;
      const call: ModelCall = {
        ...base,
        latencyMs: performance.now() - started,
        ok: true,
        responseId: response.id,
        inputTokens: usage?.input_tokens,
        cachedInputTokens: usage?.input_tokens_details?.cached_tokens,
        outputTokens: usage?.output_tokens,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
        ...(response.service_tier ? { serviceTier: response.service_tier } : {}),
      };
      const parsed = response.output_parsed;
      if (parsed === null || parsed === undefined) {
        const refusal = findRefusal(response.output);
        const failed = { ...call, ok: false, error: refusal ? `refusal: ${refusal}` : 'no parsed output' };
        this.emit(failed, req);
        throw new ModelOutputError(refusal ? `model refused: ${refusal}` : 'model returned no structured output', refusal);
      }
      this.emit(call, req);
      return { data: parsed as z.output<S>, call };
    } catch (e) {
      if (e instanceof ModelOutputError) throw e;
      this.emit({ ...base, latencyMs: performance.now() - started, ok: false, error: errorMessage(e, req.signal) }, req);
      throw e;
    }
  }

  /**
   * Streams a Responses API turn with function tools. `onEvent` sees every event as it arrives,
   * so callers can act on each completed function call before the model finishes the turn.
   * Reasoning items are returned encrypted (store: false) so the caller can replay them.
   */
  async stream(req: StreamRequest): Promise<StreamResult> {
    return req.hedge ? this.streamHedged(req) : this.streamOnce(req);
  }

  /**
   * Two identical streams; the first to produce output (an output item or a delta) wins and the
   * other is cancelled at that moment. Nothing reaches `onEvent` before a winner is chosen, so the
   * loser can never trigger actions. Time to first token varies per request (single requests
   * showed 1.2 s typical but 8–11 s spikes), so racing two cuts the spikes.
   */
  private streamHedged(req: StreamRequest): Promise<StreamResult> {
    return new Promise<StreamResult>((resolve, reject) => {
      const controllers = [new AbortController(), new AbortController()];
      const buffers: ResponseStreamEvent[][] = [[], []];
      let winner: number | null = null;
      let failures = 0;
      const progressed = (ev: ResponseStreamEvent) => ev.type === 'response.output_item.added' || ev.type.endsWith('.delta');
      const signal = (i: number) => (req.signal ? AbortSignal.any([req.signal, (controllers[i] as AbortController).signal]) : (controllers[i] as AbortController).signal);
      for (const i of [0, 1]) {
        this.streamOnce({
          ...req,
          ...(i > 0 ? { purpose: `${req.purpose}_hedge` } : {}),
          signal: signal(i),
          onEvent: (ev) => {
            if (winner === null && progressed(ev)) {
              winner = i;
              (controllers[1 - i] as AbortController).abort(new Error('hedged: the other stream answered first'));
              for (const buffered of (buffers[i] as ResponseStreamEvent[]).splice(0)) req.onEvent?.(buffered);
            }
            if (winner === i) req.onEvent?.(ev);
            else if (winner === null) (buffers[i] as ResponseStreamEvent[]).push(ev);
          },
        }).then(
          (result) => {
            // a stream that ends without ever producing output still counts if nothing else won
            if (winner === null) {
              winner = i;
              (controllers[1 - i] as AbortController).abort(new Error('hedged: the other stream answered first'));
              for (const buffered of (buffers[i] as ResponseStreamEvent[]).splice(0)) req.onEvent?.(buffered);
            }
            if (winner === i) resolve(result);
          },
          (error: unknown) => {
            failures++;
            // the winner failing mid-stream is final (its events were already acted on);
            // a failure before any output lets the other stream carry on
            if (winner === i || failures === 2 || req.signal?.aborted) reject(error);
          },
        );
      }
    });
  }

  private async streamOnce(req: StreamRequest): Promise<StreamResult> {
    const model = this.modelFor(req.tier);
    const effort = this.effortFor(req.tier, req.effort);
    const started = performance.now();
    let ttftMs: number | undefined;
    const base: Omit<ModelCall, 'latencyMs' | 'ok'> = { purpose: req.purpose, tier: req.tier, model, effort };
    try {
      const stream = await this.client.responses.create(
        {
          model,
          instructions: req.instructions,
          input: req.input,
          tools: req.tools,
          reasoning: { effort },
          store: false,
          include: ['reasoning.encrypted_content'],
          parallel_tool_calls: req.parallelToolCalls ?? true,
          stream: true,
          ...this.tierParam(req.serviceTier),
          ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
          ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
        },
        { signal: req.signal },
      );
      let final: Response | null = null;
      for await (const event of stream) {
        if (ttftMs === undefined && (event.type === 'response.output_item.added' || event.type === 'response.output_text.delta')) {
          ttftMs = performance.now() - started;
        }
        req.onEvent?.(event);
        if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response;
        else if (event.type === 'response.failed') throw new ModelOutputError(event.response.error?.message ?? 'response failed');
        else if (event.type === 'error') throw new ModelOutputError(event.message);
      }
      if (!final) throw new ModelOutputError('stream ended without a completed response');
      const usage = final.usage;
      const call: ModelCall = {
        ...base,
        latencyMs: performance.now() - started,
        ...(ttftMs !== undefined ? { ttftMs } : {}),
        ok: final.status !== 'incomplete',
        ...(final.status === 'incomplete' ? { error: `incomplete: ${final.incomplete_details?.reason ?? 'unknown'}` } : {}),
        responseId: final.id,
        inputTokens: usage?.input_tokens,
        cachedInputTokens: usage?.input_tokens_details?.cached_tokens,
        outputTokens: usage?.output_tokens,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
        ...(final.service_tier ? { serviceTier: final.service_tier } : {}),
      };
      this.emit(call, req);
      return { response: final, call };
    } catch (e) {
      this.emit({ ...base, latencyMs: performance.now() - started, ...(ttftMs !== undefined ? { ttftMs } : {}), ok: false, error: errorMessage(e, req.signal) }, req);
      throw e;
    }
  }
}

export interface StreamRequest extends ModelCallContext {
  tier: ModelTier;
  purpose: string;
  instructions: string;
  input: ResponseInput;
  tools: Tool[];
  effort?: ReasoningEffort;
  maxOutputTokens?: number;
  cacheKey?: string;
  parallelToolCalls?: boolean;
  /** overrides the gateway's service tier for this call */
  serviceTier?: ServiceTier;
  /** race two identical streams and keep the first to produce output (see streamHedged) */
  hedge?: boolean;
  onEvent?: (event: ResponseStreamEvent) => void;
}

export interface StreamResult {
  response: Response;
  call: ModelCall;
}

export interface ModelGatewayStreaming {
  stream(req: StreamRequest): Promise<StreamResult>;
}

function findRefusal(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (item && typeof item === 'object' && 'content' in item && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && typeof c === 'object' && 'type' in c && c.type === 'refusal' && 'refusal' in c) return String(c.refusal);
      }
    }
  }
  return undefined;
}

export { OpenAI };
