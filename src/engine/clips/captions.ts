import type { CaptionPresetId, ClipCaptions, ClipShort } from './types';
import { CLIP_ASPECTS } from './types';
import type { Timeline, TimelineWord } from './timeline';

/** Animated captions as an ASS script for FFmpeg/libass. The studio preview uses the same card layout and fonts, so what
 * you see while editing is what gets burned in. Text from transcripts, users and AI is escaped: it can never add tags. */
export type CaptionPreset = {
  label: string; font: string; bold: boolean; size: number; em: number; spacing: number; uppercase: boolean; maxWords: number; lines: 1 | 2;
  color: string; outline: string; outlineWidth: number; shadow: number; box: number | null; blur: number;
  active: 'color' | 'karaoke' | 'none'; pop: boolean; cardPop: boolean; emphasis: string; glow: boolean;
};
/** Sizes are for a 1080 px wide frame. Letter spacing keeps word gaps visible under thick outlines. */
export const CAPTION_PRESET_DEFS: Record<CaptionPresetId, CaptionPreset> = {
  pop: { label: 'Pop', font: 'Poppins Black', bold: false, size: 102, em: .62, spacing: 2, uppercase: false, maxWords: 3, lines: 2, color: '#FFFFFF', outline: '#000000', outlineWidth: 6.5, shadow: 3, box: null, blur: 0, active: 'color', pop: true, cardPop: true, emphasis: '#4DFF88', glow: false },
  karaoke: { label: 'Karaoke', font: 'Poppins ExtraBold', bold: false, size: 86, em: .6, spacing: 1.5, uppercase: false, maxWords: 5, lines: 2, color: '#FFFFFF', outline: '#000000', outlineWidth: 5.5, shadow: 2, box: null, blur: 0, active: 'karaoke', pop: false, cardPop: false, emphasis: '#FFFFFF', glow: false },
  boxed: { label: 'Boxed', font: 'Poppins', bold: true, size: 70, em: .58, spacing: .5, uppercase: false, maxWords: 6, lines: 2, color: '#FFFFFF', outline: '#000000', outlineWidth: 16, shadow: 0, box: .6, blur: 0, active: 'color', pop: false, cardPop: true, emphasis: '#FFFFFF', glow: false },
  impact: { label: 'Impact', font: 'Anton', bold: false, size: 132, em: .45, spacing: 2, uppercase: true, maxWords: 2, lines: 1, color: '#FFFFFF', outline: '#000000', outlineWidth: 7, shadow: 4, box: null, blur: 0, active: 'color', pop: true, cardPop: true, emphasis: '#FF4040', glow: false },
  neon: { label: 'Neon', font: 'Bebas Neue', bold: false, size: 140, em: .4, spacing: 3, uppercase: true, maxWords: 3, lines: 1, color: '#FFFFFF', outline: '#00E5FF', outlineWidth: 4, shadow: 0, box: null, blur: 5, active: 'color', pop: true, cardPop: true, emphasis: '#FF4FD8', glow: true },
  comic: { label: 'Comic', font: 'Bangers', bold: false, size: 118, em: .48, spacing: 3, uppercase: true, maxWords: 3, lines: 2, color: '#FFE600', outline: '#000000', outlineWidth: 7, shadow: 5, box: null, blur: 0, active: 'color', pop: true, cardPop: true, emphasis: '#FF5A1F', glow: false },
  minimal: { label: 'Minimal', font: 'Poppins', bold: true, size: 64, em: .56, spacing: .5, uppercase: false, maxWords: 7, lines: 2, color: '#FFFFFF', outline: '#101010', outlineWidth: 2.5, shadow: 2, box: null, blur: 0, active: 'none', pop: false, cardPop: false, emphasis: '#FFFFFF', glow: false },
  playful: { label: 'Playful', font: 'Lilita One', bold: false, size: 110, em: .5, spacing: 2, uppercase: false, maxWords: 3, lines: 2, color: '#FFFFFF', outline: '#6A2BD9', outlineWidth: 7, shadow: 4, box: null, blur: 0, active: 'color', pop: true, cardPop: true, emphasis: '#00F0B5', glow: false },
};
export const CAPTION_FONT_FILES: Record<string, string> = {
  'Poppins Black': 'Poppins-Black.ttf', 'Poppins ExtraBold': 'Poppins-ExtraBold.ttf', Poppins: 'Poppins-Bold.ttf', Anton: 'Anton-Regular.ttf',
  'Bebas Neue': 'BebasNeue-Regular.ttf', Bangers: 'Bangers-Regular.ttf', 'Lilita One': 'LilitaOne-Regular.ttf', 'Archivo Black': 'ArchivoBlack-Regular.ttf',
};

/** Text width in pixels for a font family, size and letter spacing. The server measures real glyph advances from the
 * caption TTFs and the studio uses canvas metrics; without one, an average-width estimate per preset is used. */
export type Measure = (font: string, text: string, size: number, spacing: number) => number;
export type CaptionCard = { s: number; e: number; words: TimelineWord[]; lines: number[][] };
/** Groups words into on-screen cards: at most N words, broken at sentence ends and pauses, within the safe width. */
export function captionCards(words: TimelineWord[], captions: ClipCaptions, width: number, measure?: Measure): CaptionCard[] {
  const preset = CAPTION_PRESET_DEFS[captions.preset], size = preset.size * captions.size * width / 1080, spacing = preset.spacing * captions.size * width / 1080;
  const maxWords = captions.maxWords || preset.maxWords, safeWidth = width * .86, upper = captions.uppercase ?? preset.uppercase;
  const text = (list: TimelineWord[]) => list.map(w => upper ? w.text.toUpperCase() : w.text).join(' ');
  const widthOf = (list: TimelineWord[]) => measure ? measure(preset.font, text(list), size, spacing) : text(list).length * (size * preset.em * .72 + spacing);
  const cards: CaptionCard[] = [];
  let current: TimelineWord[] = [];
  const flush = () => { if (current.length) cards.push({ s: current[0].s, e: current[current.length - 1].e, words: current, lines: [] }); current = []; };
  const fits = (list: TimelineWord[]) => widthOf(list) <= safeWidth || (preset.lines === 2 && splitLines(list).every(line => widthOf(line) <= safeWidth));
  const splitLines = (list: TimelineWord[]) => {
    let best = 1, bestWidth = Infinity;
    for (let k = 1; k < list.length; k++) { const w = Math.max(widthOf(list.slice(0, k)), widthOf(list.slice(k))); if (w < bestWidth) { bestWidth = w; best = k; } }
    return [list.slice(0, best), list.slice(best)];
  };
  for (const w of words) {
    const prev = current[current.length - 1];
    if (prev && (current.length >= maxWords || w.s - prev.e > .35 || prev.end || prev.voice !== w.voice || !fits([...current, w]))) flush();
    current.push(w);
  }
  flush();
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i], next = cards[i + 1];
    c.e = Math.max(c.s + .3, Math.min(c.e + .18, next ? next.s : c.e + .18));
    if (next && c.e > next.s) c.e = next.s;
    // Two lines only when one does not fit; split where the longer line is shortest.
    if (widthOf(c.words) <= safeWidth || c.words.length < 2) c.lines = [c.words.map((_, k) => k)];
    else { const [a] = splitLines(c.words); c.lines = [a.map((_, k) => k), c.words.slice(a.length).map((_, k) => k + a.length)]; }
  }
  return cards;
}
/** The active-word colour, swapped when it would disappear against the style's own text colour (Comic is yellow). */
export function activeColor(preset: CaptionPreset, highlight: string) {
  const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [rgb(highlight), rgb(preset.color)], d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return d >= 90 ? highlight : preset.color.toUpperCase() === '#FFFFFF' ? '#FFE600' : '#FFFFFF';
}

// ------------------------------------------------------------------ ASS
/** "#RRGGBB" + alpha (0 = opaque) to ASS "&HAABBGGRR". */
export function assColor(hex: string, alpha = 0) {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? 'FFFFFF', a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return `&H${a.toString(16).padStart(2, '0')}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}
const tagColor = (hex: string) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
/** Escapes text for an ASS Dialogue line: no override blocks, no line-break or hard-space codes from data. */
export function assText(text: string) { return text.replace(/[\u0000-\u001f]/g, ' ').replace(/\\/g, '∖').replace(/\{/g, '(').replace(/\}/g, ')'); }
export function assTime(t: number) {
  const cs = Math.max(0, Math.round(t * 100)), h = Math.floor(cs / 360000), m = Math.floor(cs % 360000 / 6000), s = Math.floor(cs % 6000 / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
/** Greedy wrap to a pixel width, then rebalanced so the hook's lines have similar lengths. */
export function wrapToWidth(text: string, maxWidth: number, width: (s: string) => number, maxLines = 3) {
  const words = text.split(/\s+/).filter(Boolean);
  const greedy = () => { const lines: string[] = []; let line = ''; for (const w of words) { const next = line ? `${line} ${w}` : w; if (line && width(next) > maxWidth) { lines.push(line); line = w; } else line = next; } if (line) lines.push(line); return lines; };
  let lines = greedy();
  if (lines.length === 2 && words.length > 2) {
    let best = lines, bestWidth = Math.max(...lines.map(width));
    for (let k = 1; k < words.length; k++) { const a = words.slice(0, k).join(' '), b = words.slice(k).join(' '), w = Math.max(width(a), width(b)); if (w < bestWidth && w <= maxWidth) { best = [a, b]; bestWidth = w; } }
    lines = best;
  }
  return lines.slice(0, maxLines);
}

/** What the output shows at an output time: faces on screen and the seams between tiles (pixels). */
export type ScreenRect = { x: number; y: number; w: number; h: number };
export type CaptionStage = (t: number) => { faces: ScreenRect[]; seams: number[] };
const overlapArea = (a: ScreenRect, b: ScreenRect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
/** The centre y for a w x h box: the previous position while it stays clear (captions should not jump around), else the
 * first clear candidate, else the candidate that covers the least. */
export function placeBox(candidates: number[], w: number, h: number, W: number, obstacles: ScreenRect[], previous: number | null = null) {
  const order = previous === null ? candidates : [previous, ...candidates.filter(c => c !== previous)];
  let best = order[0], least = Infinity;
  for (const y of order) {
    const box = { x: (W - w) / 2, y: y - h / 2, w, h }, cover = obstacles.reduce((sum, o) => sum + overlapArea(box, o), 0);
    if (!cover) return y;
    if (cover < least) { least = cover; best = y; }
  }
  return best;
}

export type AssOptions = { timeline: Timeline; short: Pick<ClipShort, 'captions' | 'hook' | 'overlays' | 'aspect'>; hookText: string; creditText: string; measure?: Measure; stage?: CaptionStage };
export function buildAss({ timeline, short, hookText, creditText, measure, stage }: AssOptions) {
  const [W, H] = CLIP_ASPECTS[short.aspect], scale = W / 1080, caps = short.captions, preset = CAPTION_PRESET_DEFS[caps.preset], vertical = short.aspect === '9:16';
  const size = Math.round(preset.size * caps.size * scale), upper = caps.uppercase ?? preset.uppercase, highlight = activeColor(preset, caps.highlight);
  const fixedY = Math.round(H * (caps.position === 'upper' ? .3 : caps.position === 'middle' ? .52 : vertical ? .7 : .78));
  const style = (name: string, font: string, fontSize: number, primary: string, outline: string, back: string, bold: boolean, border: 1 | 3, outlineW: number, shadow: number, align = 5, spacing = 0) =>
    `Style: ${name},${font},${fontSize},${primary},${primary},${outline},${back},${bold ? -1 : 0},0,0,0,100,100,${Math.round(spacing * 10) / 10},0,${border},${Math.round(outlineW * 10) / 10},${Math.round(shadow * 10) / 10},${align},40,40,40,1`;
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', 'YCbCr Matrix: TV.709', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // With BorderStyle 3 libass fills the box with the outline colour, so the box opacity lives there.
    style('Caption', preset.font, size, assColor(preset.color), assColor(preset.outline, preset.box !== null ? 1 - preset.box : 0), assColor('#000000', .45), preset.bold, preset.box !== null ? 3 : 1, preset.outlineWidth * scale * caps.size, preset.shadow * scale * caps.size, 5, preset.spacing * scale * caps.size),
    style('Hook', 'Poppins Black', Math.round(82 * scale), assColor('#FFFFFF'), assColor('#000000', .12), assColor('#000000', .12), false, 3, 24 * scale, 0, 5, 1),
    style('Credit', 'Poppins', Math.round(40 * scale), assColor('#FFFFFF', .15), assColor('#000000', .35), assColor('#000000', .55), true, 1, 3 * scale, 1.5 * scale, 7),
    style('Bar', 'Poppins', 10, assColor(highlight), assColor(highlight), assColor('#000000', 1), false, 1, 0, 0, 7),
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const dialogue = (layer: number, s: number, e: number, styleName: string, text: string) => { if (e - s >= .02) lines.push(`Dialogue: ${layer},${assTime(s)},${assTime(e)},${styleName},,0,0,0,,${text}`); };
  const hookEnd = short.hook.enabled && hookText ? Math.min(timeline.duration, short.hook.seconds) : 0;
  // Auto placement keeps text off faces as they appear in the final frame (after crops, tiles and punch-ins), inside
  // the area the platforms' own buttons and captions leave free.
  const auto = caps.position === 'auto' && !!stage;
  const facesDuring = (s: number, e: number) => stage ? [s, (s + e) / 2, Math.max(s, e - .01)].flatMap(t => stage(t).faces).map(f => ({ x: f.x - W * .02, y: f.y - H * .04, w: f.w + W * .04, h: f.h + H * .06 })) : [];
  const inside = (y: number, h: number) => y - h / 2 >= H * .06 && y + h / 2 <= H * (vertical ? .86 : .94);

  const hookSize = Math.round(82 * scale), hookWidth = (s: string) => measure ? measure('Poppins Black', s, hookSize, scale) : s.length * hookSize * .5;
  const hookLines = hookEnd > 0 ? wrapToWidth(assText(hookText), W * .78, hookWidth) : [];
  const hookBox = { w: Math.max(0, ...hookLines.map(hookWidth)) + 60 * scale, h: hookLines.length * hookSize * 1.2 + 48 * scale };
  const hookY = !hookLines.length ? 0 : !auto ? Math.round(H * (vertical ? .2 : .16))
    : placeBox((vertical ? [.2, .14, .28, .38, .48] : [.16, .1, .24, .34]).map(f => Math.round(H * f)).filter(y => inside(y, hookBox.h)), hookBox.w, hookBox.h, W, facesDuring(0, hookEnd));
  const hookRect = { x: (W - hookBox.w) / 2, y: hookY - hookBox.h / 2, w: hookBox.w, h: hookBox.h };

  if (caps.enabled) {
    const cards = captionCards(timeline.words, caps, W, measure);
    const spacing = preset.spacing * caps.size * scale, outline = preset.outlineWidth * scale * caps.size + (preset.box !== null ? 8 * scale : 0);
    const textWidth = (list: TimelineWord[]) => { const text = list.map(w => upper ? w.text.toUpperCase() : w.text).join(' '); return measure ? measure(preset.font, text, size, spacing) : text.length * (size * preset.em * .72 + spacing); };
    let previous: number | null = null;
    for (const card of cards) {
      // Captions give way to the hook card while it is on screen when both sit in the upper third.
      const s = caps.position === 'upper' && card.s < hookEnd ? hookEnd : card.s;
      if (card.e <= s) continue;
      let y = fixedY;
      if (auto) {
        // Pops scale the active word up to 116%, so the box keeps some slack.
        const w = Math.max(...card.lines.map(line => textWidth(line.map(k => card.words[k])))) * 1.1 + outline * 2, h = card.lines.length * size * 1.2 + outline * 2;
        const obstacles = facesDuring(s, card.e);
        if (hookLines.length && s < hookEnd) obstacles.push(hookRect);
        const seams = stage!((s + card.e) / 2).seams.filter(v => v > H * .15 && v < H * .85).sort((a, b) => Math.abs(a - H * .6) - Math.abs(b - H * .6));
        const options = [...seams, ...[vertical ? .7 : .78, vertical ? .77 : .86, vertical ? .62 : .7, .52, .42, .3].map(f => Math.round(H * f))].filter(v => inside(v, h));
        y = previous = placeBox(options.length ? options : [fixedY], w, h, W, obstacles, previous !== null && inside(previous, h) ? previous : null);
      }
      const cardPop = '\\fscx86\\fscy86\\t(0,90,\\fscx100\\fscy100)';
      // After a styled word the line returns to the card's own state (including its pop-in animation when running).
      const render = (active: number, scaleState: string) => card.lines.map(line => line.map(k => {
        const w = card.words[k], text = assText(upper ? w.text.toUpperCase() : w.text);
        const on = preset.active === 'karaoke' ? k <= active : k === active;
        const color = on && preset.active !== 'none' ? highlight : caps.emphasis && w.emphasis ? preset.emphasis : null;
        const pop = on && preset.pop && k === active;
        if (!color && !pop) return text;
        return `{${color ? `\\c${tagColor(color)}` : ''}${pop ? '\\fscx116\\fscy116\\t(0,90,\\fscx106\\fscy106)' : ''}${preset.glow && color ? `\\3c${tagColor(color)}` : ''}}${text}{\\c${tagColor(preset.color)}\\3c${tagColor(preset.outline)}${pop ? scaleState : ''}}`;
      }).join(' ')).join('\\N');
      const head = `{\\an5\\pos(${W / 2},${y})${preset.blur ? `\\blur${preset.blur}` : ''}`;
      if (preset.active === 'none') { dialogue(2, s, card.e, 'Caption', `${head}${preset.cardPop ? cardPop : ''}}${render(-1, '')}`); continue; }
      card.words.forEach((w, k) => {
        const from = k === 0 ? s : Math.max(s, w.s), to = k + 1 < card.words.length ? Math.max(from, card.words[k + 1].s) : card.e;
        const popping = k === 0 && preset.cardPop;
        dialogue(2, from, to, 'Caption', `${head}${popping ? cardPop : ''}}${render(k, popping ? cardPop : '\\fscx100\\fscy100')}`);
      });
    }
  }
  if (hookLines.length) dialogue(4, 0, hookEnd, 'Hook', `{\\an5\\pos(${W / 2},${hookY})\\fscx70\\fscy70\\t(0,120,\\fscx104\\fscy104)\\t(120,200,\\fscx100\\fscy100)\\fad(0,180)}${hookLines.join('\\N')}`);
  if (short.overlays.credit && creditText) dialogue(1, 0, timeline.duration, 'Credit', `{\\an7\\pos(${Math.round(56 * scale)},${Math.round(H * (short.aspect === '9:16' ? .095 : .05))})}${assText(creditText)}`);
  if (short.overlays.progress && timeline.duration > 1) {
    const top = H - Math.round(12 * scale), ms = Math.round(timeline.duration * 1000);
    dialogue(3, 0, timeline.duration, 'Bar', `{\\an7\\pos(0,0)\\p1\\1a&H10&\\clip(0,${top},0,${H})\\t(0,${ms},\\clip(0,${top},${W},${H}))}m 0 ${top} l ${W} ${top} ${W} ${H} 0 ${H}{\\p0}`);
  }
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------ SRT
const srtTime = (t: number) => { const ms = Math.max(0, Math.round(t * 1000)); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
/** Platform-friendly subtitles (up to ~7 words or 42 characters per cue) for YouTube, TikTok and editors. */
export function buildSrt(words: TimelineWord[]) {
  const cues: { s: number; e: number; text: string }[] = [];
  let cur: TimelineWord[] = [];
  const flush = () => { if (cur.length) cues.push({ s: cur[0].s, e: cur[cur.length - 1].e, text: cur.map(w => w.text).join(' ') }); cur = []; };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (cur.length >= 7 || w.s - prev.e > .6 || prev.end || (cur.map(x => x.text).join(' ') + ' ' + w.text).length > 42)) flush();
    cur.push(w);
  }
  flush();
  // Many players read ASS-style {\tags} inside SRT, so braces from transcripts are neutralised here too.
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.s)} --> ${srtTime(Math.max(c.e, c.s + .5))}\n${c.text.replace(/[\r\n]+/g, ' ').replace(/\{/g, '(').replace(/\}/g, ')')}\n`).join('\n');
}
