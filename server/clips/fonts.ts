import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CAPTION_FONT_FILES } from '../../src/engine/clips/captions';

/** Advance widths straight from the caption TTFs (cmap + hmtx), so line breaks in burned-in captions match the real
 * glyphs instead of a character-count guess. Kerning is ignored (it moves words by a few pixels at most). */
type Metrics = { unitsPerEm: number; advance: (code: number) => number };
function parseTtf(buf: Buffer): Metrics {
  const tables = new Map<string, number>(), count = buf.readUInt16BE(4);
  for (let i = 0; i < count; i++) { const o = 12 + i * 16; tables.set(buf.toString('ascii', o, o + 4), buf.readUInt32BE(o + 8)); }
  const head = tables.get('head'), hhea = tables.get('hhea'), hmtx = tables.get('hmtx'), cmap = tables.get('cmap');
  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) throw new Error('Unsupported font.');
  const unitsPerEm = buf.readUInt16BE(head + 18), metrics = buf.readUInt16BE(hhea + 34);
  const width = (glyph: number) => buf.readUInt16BE(hmtx + 4 * Math.min(glyph, metrics - 1));
  // Unicode BMP subtable (platform 3, encoding 1, format 4).
  let sub = -1;
  for (let i = 0, n = buf.readUInt16BE(cmap + 2); i < n; i++) {
    const r = cmap + 4 + i * 8, platform = buf.readUInt16BE(r), encoding = buf.readUInt16BE(r + 2), offset = cmap + buf.readUInt32BE(r + 4);
    if (platform === 3 && encoding === 1 && buf.readUInt16BE(offset) === 4) sub = offset;
  }
  const cache = new Map<number, number>();
  const glyphOf = (code: number) => {
    if (sub < 0 || code > 0xffff) return 0;
    const segX2 = buf.readUInt16BE(sub + 6), ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = buf.readUInt16BE(ends + 2 * i);
      if (code > end) continue;
      const start = buf.readUInt16BE(starts + 2 * i);
      if (code < start) return 0;
      const delta = buf.readInt16BE(deltas + 2 * i), rangeOffset = buf.readUInt16BE(ranges + 2 * i);
      if (!rangeOffset) return (code + delta) & 0xffff;
      const glyph = buf.readUInt16BE(ranges + 2 * i + rangeOffset + 2 * (code - start));
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  };
  return { unitsPerEm, advance: code => { let w = cache.get(code); if (w === undefined) { w = width(glyphOf(code)); cache.set(code, w); } return w; } };
}

const loaded = new Map<string, Metrics | null>();
/** measure(font family, text, size px, letter spacing px) in pixels; unknown fonts fall back to 0.55 em per character. */
export function fontMeasurer(fontsDir: string) {
  return (font: string, text: string, size: number, spacing = 0) => {
    let m = loaded.get(font);
    if (m === undefined) {
      const file = CAPTION_FONT_FILES[font];
      try { m = file ? parseTtf(readFileSync(path.join(fontsDir, file))) : null; } catch { m = null; }
      loaded.set(font, m);
    }
    const chars = [...text];
    if (!m) return chars.length * size * .55 + chars.length * spacing;
    let units = 0;
    for (const ch of chars) units += m.advance(ch.codePointAt(0) ?? 32);
    return units / m.unitsPerEm * size + chars.length * spacing;
  };
}
