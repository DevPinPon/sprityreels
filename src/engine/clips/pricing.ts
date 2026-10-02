/** Gemini API list prices (USD per 1M tokens, paid tier, standard inference) as published at
 * ai.google.dev/gemini-api/docs/pricing on September 28, 2026. Launch prices apply through December 31, 2026 and
 * double on January 1, 2027. The free tier costs nothing; the ledger still shows list-price estimates. */
export const GEMINI_PRICES = {
  'gemini-3.8-flash': { launch: { input: .75, output: 3.75 }, standard: { input: 1.5, output: 7.5 } },
  'gemini-3.8-flash-tts': { launch: { input: .5, output: 9 }, standard: { input: 1, output: 18 } },
  'gemini-3.8-flash-lite-tts': { launch: { input: .5, output: 6 }, standard: { input: 1, output: 12 } },
} as const;
export type GeminiModel = keyof typeof GEMINI_PRICES;
export const GEMINI_TEXT_MODEL: GeminiModel = 'gemini-3.8-flash';
export const TTS_TOKENS_PER_SECOND = 25;
const LAUNCH_ENDS = Date.UTC(2027, 0, 1);

export function geminiPrice(model: GeminiModel, at = Date.now()) { return at < LAUNCH_ENDS ? GEMINI_PRICES[model].launch : GEMINI_PRICES[model].standard; }
/** Cost of one call; thinking tokens bill as output. */
export function geminiCost(model: GeminiModel, inputTokens: number, outputTokens: number, at = Date.now()) {
  const p = geminiPrice(model, at);
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}
/** Estimates before a call: ~4 characters per text token; TTS output is 25 audio tokens per second of speech. */
export function estimateTextCost(promptChars: number, outputTokens = 2500, at = Date.now()) { return geminiCost(GEMINI_TEXT_MODEL, Math.ceil(promptChars / 4) + 600, outputTokens, at); }
export function estimateSpeechCost(model: 'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts', text: string, at = Date.now()) {
  const words = text.split(/\s+/).filter(Boolean).length, seconds = Math.max(1, words / 2.6);
  return { seconds, usd: geminiCost(model, Math.ceil(text.length / 4) + 40, Math.ceil(seconds * TTS_TOKENS_PER_SECOND), at) };
}
export const usd = (value: number) => value === 0 ? '$0' : value < .01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
