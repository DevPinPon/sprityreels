/** Swear-word filter for shorts: matching words are masked in the captions and subtitles ("f******") and bleeped or
 * muted in the audio, which keeps clips advertiser-friendly. The built-in list covers common English profanity; the
 * creator adds anything else (other languages, names, slurs) as their own words, where "word*" also matches endings. */
const PROFANITY = [
  /^(mother|mutha)?f+u+c*k+[a-z]*$/,
  /^(bull|horse|dip|chicken|holy)?sh+i+t+(e|s|ty|ter|ters|ted|ting|head|heads|hole|holes|show|load|faced|less)?$/,
  /^bitch(es|y|ing|ed)?$/,
  /^ass(hole|holes|hat|hats|wipe|wipes)$/, /^(dumb|jack|smart|lard|fat)ass(es)?$/,
  /^bastards?$/, /^dick(head|heads|wad|wads)$/, /^cunts?$/, /^god-?damn(it|ed)?$/,
  /^cocksuck(er|ers|ing)$/, /^wank(er|ers|ing)?$/, /^twats?$/, /^bollocks$/,
];
export const CENSOR_LIMITS = { words: 50, wordChars: 30 } as const;
const bare = (text: string) => text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}*'-]+/gu, '').replace(/^['-]+|['-]+$/g, '');

/** A matcher for the built-in list plus the creator's words ("word" exact, "word*" as a prefix). */
export function censorMatcher(custom: string[] = []) {
  const exact = new Set<string>(), prefixes: string[] = [];
  for (const raw of custom) { const w = bare(raw); if (!w) continue; if (w.endsWith('*')) { if (w.length > 2) prefixes.push(w.slice(0, -1).replace(/\*/g, '')); } else exact.add(w.replace(/\*/g, '')); }
  return (text: string) => {
    const w = bare(text).replace(/\*/g, '');
    return !!w && (exact.has(w) || prefixes.some(p => w.startsWith(p)) || PROFANITY.some(re => re.test(w)));
  };
}
/** "Fucking," becomes "F******,": the first letter stays so the word is still readable as a word. */
export const maskWord = (text: string) => text.replace(/[\p{L}\p{N}]+/u, m => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
