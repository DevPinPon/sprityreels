import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';

/** Seats for AI "directors" that rank moments or write scripts besides the built-in Gemini client. A hosted website cannot
 * use a visitor's local subscriptions (Codex, Claude Code), so the seat it fills is Claude through the Anthropic API:
 * set ANTHROPIC_API_KEY and the studio offers "Rank with AI" with a vision model that also looks at frames of the video. */
export type DirectorStatus = { available: boolean; connected: boolean; reason?: string; plan?: string | null; message: string };
/** A picture shown to a vision model, held in memory (nothing is written to disk for it). */
export type DirectorImage = { mime: 'image/jpeg' | 'image/png'; data: Buffer };
/** images: local JPEG/PNG files for a director that reads files (the caller deletes them when the request ends);
 * imageData: the same pictures in memory, for a director that sends them over the network. Only a director with vision
 * reads either; the others get the text. */
export type DirectorRequest = { system: string; prompt: string; schema: object; cwd: string; timeoutMs: number; signal: AbortSignal; images?: string[]; imageData?: DirectorImage[];
  /** The same prompt in two parts: `stable` (what stays the same for a video however it is asked) and `ask` (this time's question). A director whose
   * input can be cached puts the stable part first and reuses it; the others use `prompt`. */
  cacheable?: { stable: string; ask: string } };
export type DirectorAnswer = { text: string; model?: string; usage?: { inputTokens: number; outputTokens: number; usd?: number } };
/** The director cannot run right now (missing key, sign-in, rate limit); its message says what to do. */
export class DirectorUnavailableError extends Error {}
export interface TextDirector {
  readonly vision?: boolean;
  /** How a vision director wants its pictures: 'data' (in memory, nothing on disk) or 'files' (paths; the default). */
  readonly imageInput?: 'files' | 'data';
  status(force?: boolean): Promise<DirectorStatus>;
  generate(request: DirectorRequest): Promise<DirectorAnswer>;
  dispose(): void;
}

/** USD per million tokens (input, output): Anthropic's published list prices as of 2026-09-25. A model that is not listed
 * is recorded without a price. */
const CLAUDE_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 }, 'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 }, 'claude-sonnet-5': { input: 2, output: 10 },
  'claude-fable-5-1': { input: 10, output: 50 }, 'claude-haiku-4-5': { input: 1, output: 5 },
};
/** Opus 5.5 is the default; SPRITYREELS_CLAUDE_MODEL=claude-sonnet-5-5 halves the price (compare picks before switching). */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Structured outputs accept a subset of JSON Schema: numeric, string-length and array-size limits are removed here (the
 * studio checks every answer itself when it reads it). */
const UNSUPPORTED = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'uniqueItems']);
export function structuredSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(structuredSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED.has(key) || (key === 'minItems' && Number(value) > 1)) continue;
    out[key] = key === 'properties' && value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, structuredSchema(v)])) : structuredSchema(value);
  }
  return out;
}

export type ClaudeDirectorOptions = {
  /** Default: ANTHROPIC_API_KEY (read on every call, so the operator can add it while the server runs). */
  apiKey?: () => string | undefined;
  /** Default: SPRITYREELS_CLAUDE_MODEL, then claude-opus-5-5. */
  model?: string;
  /** How hard the model thinks: low | medium | high | xhigh | max. Default: SPRITYREELS_CLAUDE_EFFORT, then medium. */
  effort?: Effort;
  /** Cache the stable part of the prompt (the pictures and the transcript) for five minutes. It costs 25% more input the first time and 90% less every
   * time after, so it pays when a video is asked about more than about once in five (SPRITYREELS_CLAUDE_CACHE=1). */
  cache?: boolean;
  /** Tests point this at a local server. */
  baseURL?: string;
};

/** Claude through the official Anthropic SDK. The answer is requested as JSON with structured outputs (these models do not
 * allow forced tool use); a request that a safety classifier declines is retried by the API on its recommended fallback
 * model (server-side fallbacks). The key stays on the server: it is never returned, logged or put in an error. */
export class ClaudeDirector implements TextDirector {
  readonly vision = true;
  readonly imageInput = 'data' as const;
  constructor(private options: ClaudeDirectorOptions = {}) {}
  private key() { return (this.options.apiKey ? this.options.apiKey() : process.env.ANTHROPIC_API_KEY)?.trim() || null; }
  private model() { return this.options.model ?? (process.env.SPRITYREELS_CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL); }
  private effort(): Effort { const e = this.options.effort ?? process.env.SPRITYREELS_CLAUDE_EFFORT?.trim(); return EFFORTS.includes(e ?? '') ? e as Effort : 'medium'; }

  async status(): Promise<DirectorStatus> {
    return this.key()
      ? { available: true, connected: true, plan: null, message: `Claude (${this.model()}) reads the transcript and looks at frames of the video.` }
      : { available: false, connected: false, reason: 'no-key', plan: null, message: 'Claude is not set up on this server (ANTHROPIC_API_KEY is missing).' };
  }

  async generate(request: DirectorRequest): Promise<DirectorAnswer> {
    const key = this.key();
    if (!key) throw new DirectorUnavailableError('Claude is not set up on this server (ANTHROPIC_API_KEY is missing).');
    const pictures = request.imageData ?? await Promise.all((request.images ?? []).map(async file => ({ mime: /\.png$/i.test(file) ? 'image/png' as const : 'image/jpeg' as const, data: await readFile(file) })));
    const cached = (this.options.cache ?? process.env.SPRITYREELS_CLAUDE_CACHE === '1') && request.cacheable;
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...pictures.map(p => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: p.mime, data: p.data.toString('base64') } })),
      ...(cached ? [{ type: 'text' as const, text: cached.stable, cache_control: { type: 'ephemeral' as const } }, { type: 'text' as const, text: cached.ask }] : [{ type: 'text' as const, text: request.prompt }]),
    ];
    const model = this.model();
    const client = new Anthropic({ apiKey: key, ...(this.options.baseURL ? { baseURL: this.options.baseURL } : {}), maxRetries: 2, timeout: request.timeoutMs });
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await client.beta.messages.create({
        model, max_tokens: 16_000, system: request.system, messages: [{ role: 'user', content }],
        output_config: { effort: this.effort(), format: { type: 'json_schema', schema: structuredSchema(request.schema) as Record<string, unknown> } },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      }, { signal: request.signal, timeout: request.timeoutMs });
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new DirectorUnavailableError('Claude rejected the API key, or this project cannot use the model. The server operator should check ANTHROPIC_API_KEY.');
      if (error instanceof Anthropic.RateLimitError) throw new DirectorUnavailableError('Claude is busy right now (rate limit). Try again in a minute.');
      if (error instanceof Anthropic.APIConnectionTimeoutError) throw new DirectorUnavailableError('Claude took too long to answer.');
      if (error instanceof Anthropic.APIConnectionError) throw new DirectorUnavailableError('Could not reach Claude. Check the internet connection.');
      if (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500) throw new DirectorUnavailableError('Claude is temporarily unavailable. Try again shortly.');
      if (error instanceof Anthropic.APIError) throw new Error('Claude could not complete the request.');
      throw error;
    }
    // Branch on stop_reason before reading the content.
    if (message.stop_reason === 'refusal') throw new DirectorUnavailableError('Claude declined to rank this video. The automatic picks are still available.');
    if (message.stop_reason === 'max_tokens') throw new DirectorUnavailableError('Claude’s answer was cut off. Try again, or ask for fewer moments.');
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    if (!text.trim()) throw new DirectorUnavailableError('Claude returned an empty answer.');
    // Input that was written to the cache costs 1.25 times the normal price, input read from it 0.1 times.
    const u = message.usage, fresh = u.input_tokens ?? 0, written = u.cache_creation_input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0, outputTokens = u.output_tokens ?? 0, price = CLAUDE_PRICES[message.model] ?? CLAUDE_PRICES[model];
    return { text, model: message.model || model, usage: { inputTokens: fresh + written + read, outputTokens, usd: price ? ((fresh + written * 1.25 + read * 0.1) * price.input + outputTokens * price.output) / 1e6 : 0 } };
  }
  dispose() {}
}

/** The seats a hosted studio fills: Claude, which reports itself unavailable until ANTHROPIC_API_KEY is set. */
export const defaultDirectors = (): Partial<Record<'codex' | 'claude', TextDirector>> => ({ claude: new ClaudeDirector() });
