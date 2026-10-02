import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GeminiModel } from '../../src/engine/clips/pricing';
import { GEMINI_TEXT_MODEL, TTS_TOKENS_PER_SECOND, geminiCost } from '../../src/engine/clips/pricing';

/** Gemini 3.8 through the Interactions API (REST), used only for the steps the creator asks for: moment ranking,
 * commentary scripts and TTS voiceovers. The API key comes from GEMINI_API_KEY or the studio settings file; it is never
 * returned to the browser, logged or written into errors. Requests are sent with store=false. */
export class GeminiError extends Error { constructor(message: string, readonly status = 502) { super(message); } }
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export type GeminiUsage = { inputTokens: number; outputTokens: number; usd: number };
export type LedgerEntry = { t: number; kind: 'moments' | 'script' | 'voice' | 'verify'; model: string; sourceId: string | null; shortId: string | null; inputTokens: number; outputTokens: number; usd: number; seconds?: number };
type Fetch = typeof fetch;

export class GeminiKeys {
  constructor(private file: string) {}
  async get(): Promise<{ key: string; source: 'env' | 'file' } | null> {
    const env = process.env.GEMINI_API_KEY?.trim();
    if (env) return { key: env, source: 'env' };
    try { const v = JSON.parse(await readFile(this.file, 'utf8')); if (typeof v.key === 'string' && v.key) return { key: v.key, source: 'file' }; } catch { /* no key saved */ }
    return null;
  }
  /** Only a hint of the key leaves this class. */
  async status() {
    const k = await this.get();
    return k ? { configured: true, source: k.source, hint: `…${k.key.slice(-4)}` } : { configured: false, source: null, hint: null };
  }
  async save(key: string) {
    if (!/^[A-Za-z0-9_\-.]{20,200}$/.test(key)) throw new GeminiError('That does not look like a Gemini API key. Copy it from Google AI Studio → Get API key.', 400);
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ key, saved: Date.now() }), { mode: 0o600 });
  }
  async remove() { await rm(this.file, { force: true }); }
}

export class UsageLedger {
  /** onAdd hears every entry once it is written (the website adds them up for its daily budget). */
  constructor(private file: string, private onAdd?: (entry: LedgerEntry) => void) {}
  async add(entry: LedgerEntry) { await mkdir(path.dirname(this.file), { recursive: true }); await appendFile(this.file, `${JSON.stringify(entry)}\n`); try { this.onAdd?.(entry); } catch { /* a listener must not break the call */ } }
  async entries(): Promise<LedgerEntry[]> {
    try { return (await readFile(this.file, 'utf8')).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) as LedgerEntry; } catch { return null; } }).filter((e): e is LedgerEntry => !!e); }
    catch { return []; }
  }
  async summary(now = Date.now()) {
    const all = await this.entries(), month = new Date(now), start = Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1);
    const inMonth = all.filter(e => e.t >= start), sum = (list: LedgerEntry[]) => Math.round(list.reduce((s, e) => s + e.usd, 0) * 1e8) / 1e8;
    return { monthUsd: sum(inMonth), totalUsd: sum(all), calls: inMonth.length, voiceSeconds: Math.round(inMonth.reduce((s, e) => s + (e.seconds ?? 0), 0)),
      byShort: Object.fromEntries([...new Set(all.map(e => e.shortId).filter((s): s is string => !!s))].map(id => [id, sum(all.filter(e => e.shortId === id))])) };
  }
}

function publicError(status: number, body: string) {
  const detail = (() => { try { return String(JSON.parse(body)?.error?.message ?? ''); } catch { return ''; } })().replace(/key=[^\s&]+/gi, 'key=…').slice(0, 240);
  if (status === 400 && /api key/i.test(detail)) return new GeminiError('Gemini rejected the API key. The server operator should check GEMINI_API_KEY.', 401);
  if (status === 401 || status === 403) return new GeminiError('Gemini rejected the API key or this project cannot use the model. The server operator should check GEMINI_API_KEY.', 401);
  if (status === 429) return new GeminiError('Gemini rate limit or quota reached (free-tier limits are low). Wait a minute, or enable billing in Google AI Studio.', 429);
  if (status >= 500) return new GeminiError('Gemini is temporarily unavailable. Try again shortly.', 503);
  return new GeminiError(`Gemini could not complete the request${detail ? `: ${detail}` : '.'}`, 502);
}

export class GeminiClient {
  constructor(readonly keys: GeminiKeys, readonly ledger: UsageLedger, private fetchImpl: Fetch = fetch, private retries = 2) {}
  private async call(body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 180_000) {
    const key = await this.keys.get();
    if (!key) throw new GeminiError('AI picks are not set up on this server (GEMINI_API_KEY is missing).', 412);
    let last: GeminiError | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 1500 * 2 ** (attempt - 1)));
      const timeout = AbortSignal.timeout(timeoutMs), both = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response;
      try { res = await this.fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.key }, body: JSON.stringify({ ...body, store: false }), signal: both }); }
      catch (error) {
        if (signal?.aborted) throw new GeminiError('Cancelled.', 499);
        last = new GeminiError(timeout.aborted ? 'Gemini took too long to answer.' : 'Could not reach Gemini. Check the internet connection.', 503); continue;
      }
      const text = await res.text();
      if (res.ok) { try { return JSON.parse(text); } catch { throw new GeminiError('Gemini returned an unreadable answer.'); } }
      last = publicError(res.status, text);
      if (res.status !== 429 && res.status < 500) break;
    }
    throw last ?? new GeminiError('Gemini request failed.');
  }
  private static outputs(reply: any) {
    const steps: any[] = Array.isArray(reply?.steps) ? reply.steps : [];
    return steps.filter(s => s?.type === 'model_output').flatMap(s => Array.isArray(s.content) ? s.content : []);
  }
  private static usage(reply: any) {
    const u = reply?.usage ?? {};
    const out = (Number(u.total_output_tokens) || 0) + (Number(u.total_thought_tokens) || 0);
    return { inputTokens: Number(u.total_input_tokens) || 0, outputTokens: out };
  }
  /** Structured JSON output (response_format with a JSON schema). */
  async json(opts: { system: string; prompt: string; schema: object; signal?: AbortSignal; kind: 'moments' | 'script'; sourceId?: string | null; shortId?: string | null }) {
    const reply = await this.call({
      model: GEMINI_TEXT_MODEL, system_instruction: opts.system, input: opts.prompt,
      response_format: { type: 'text', mime_type: 'application/json', schema: opts.schema },
      generation_config: { thinking_level: 'low' },
    }, opts.signal);
    const text = GeminiClient.outputs(reply).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('');
    if (!text.trim()) throw new GeminiError('Gemini returned an empty answer.');
    const u = GeminiClient.usage(reply), usd = geminiCost(GEMINI_TEXT_MODEL, u.inputTokens, u.outputTokens);
    await this.ledger.add({ t: Date.now(), kind: opts.kind, model: GEMINI_TEXT_MODEL, sourceId: opts.sourceId ?? null, shortId: opts.shortId ?? null, ...u, usd });
    return { text, usage: { ...u, usd } as GeminiUsage, model: GEMINI_TEXT_MODEL as string };
  }
  /** Gemini 3.8 TTS: verbatim text, turn-level style, one prebuilt voice. Returns WAV bytes (24 kHz mono). */
  async speech(opts: { model: 'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts'; text: string; style: string; voice: string; signal?: AbortSignal; sourceId?: string | null; shortId?: string | null }) {
    const content: Record<string, unknown> = { type: 'text', text: opts.text };
    if (opts.style.trim()) content.annotations = [{ type: 'speech_metadata', style: opts.style.trim().slice(0, 200) }];
    const reply = await this.call({ model: opts.model, input: [{ type: 'user_input', content: [content] }], response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: opts.voice }] } }, opts.signal, 240_000);
    const audio = GeminiClient.outputs(reply).filter(c => c?.type === 'audio' && typeof c.data === 'string').pop();
    if (!audio) throw new GeminiError('Gemini returned no audio for this line.');
    const bytes = Buffer.from(audio.data, 'base64');
    const wav = bytes.toString('ascii', 0, 4) === 'RIFF' ? bytes : pcmToWav(bytes, 24000);
    const seconds = wavSeconds(wav), u = GeminiClient.usage(reply);
    const outputTokens = u.outputTokens || Math.ceil(seconds * TTS_TOKENS_PER_SECOND), usd = geminiCost(opts.model as GeminiModel, u.inputTokens || Math.ceil(opts.text.length / 4), outputTokens);
    await this.ledger.add({ t: Date.now(), kind: 'voice', model: opts.model, sourceId: opts.sourceId ?? null, shortId: opts.shortId ?? null, inputTokens: u.inputTokens, outputTokens, usd, seconds });
    return { wav, seconds, usd };
  }
}

export function pcmToWav(pcm: Buffer, rate: number) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export function wavSeconds(wav: Buffer) {
  let p = 12, rate = 24000, channels = 1, bits = 16;
  while (p + 8 <= wav.length) {
    const id = wav.toString('ascii', p, p + 4), n = wav.readUInt32LE(p + 4);
    if (id === 'fmt ') { channels = wav.readUInt16LE(p + 10); rate = wav.readUInt32LE(p + 12); bits = wav.readUInt16LE(p + 22); }
    if (id === 'data') return Math.min(n, wav.length - p - 8) / (rate * channels * bits / 8);
    p += 8 + n + (n % 2);
  }
  return 0;
}
