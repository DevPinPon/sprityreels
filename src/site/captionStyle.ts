import type { CSSProperties } from 'react';
import { CAPTION_PRESET_DEFS, activeColor } from '../engine/clips/captions';
import type { CaptionPresetId } from '../engine/clips/types';

export const CAPTION_NOTES: Record<CaptionPresetId, string> = {
  pop: 'Bold and bouncy, word by word', karaoke: 'Reads along with the voice', boxed: 'A clean box behind the words', impact: 'Huge, uppercase and punchy',
  neon: 'Tall and glowing', comic: 'Comic-book energy', minimal: 'Quiet and small', playful: 'Rounded and friendly',
};

/** CSS that mimics a render preset (same fonts, colours and outlines) at an on-screen frame width. The renderer sizes captions
 * for a 1080 px wide frame, so everything scales by frameWidth / 1080. */
export function captionStyle(id: CaptionPresetId, frameWidth: number, highlight = '#FFE600') {
  const d = CAPTION_PRESET_DEFS[id], k = frameWidth / 1080, active = activeColor(d, highlight);
  const line: CSSProperties = d.box !== null ? { display: 'inline-block', padding: `${18 * k}px ${26 * k}px`, borderRadius: 18 * k, background: `rgba(0, 0, 0, ${d.box})` } : {};
  const word = (on: boolean): CSSProperties => ({
    fontFamily: `'${d.font}', ui-sans-serif, sans-serif`, fontWeight: d.bold ? 700 : 400, fontSize: d.size * k, letterSpacing: d.spacing * k, textTransform: d.uppercase ? 'uppercase' : 'none',
    color: on && d.active !== 'none' ? active : d.color,
    ...(d.box === null ? { WebkitTextStroke: `${2 * d.outlineWidth * k}px ${d.outline}`, paintOrder: 'stroke fill' } : {}),
    textShadow: d.glow ? `0 0 ${14 * k}px ${d.outline}, 0 0 ${34 * k}px ${d.outline}` : d.shadow ? `0 ${d.shadow * k}px ${d.shadow * 1.6 * k}px rgba(0, 0, 0, .55)` : 'none',
  });
  return { line, word, size: d.size * k, uppercase: d.uppercase };
}
