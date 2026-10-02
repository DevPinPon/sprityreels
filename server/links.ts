import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './support';

/** A public service that runs yt-dlp on pasted links must never be talked into fetching its own network (a cloud
 * metadata address, a router, another service on this machine). Links must come from a known site, and every address
 * the host name resolves to must be a public one. */
export const DEFAULT_LINK_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'twitch.tv', 'x.com', 'twitter.com', 'instagram.com', 'facebook.com', 'fb.watch', 'rumble.com', 'kick.com', 'dailymotion.com', 'loom.com', 'streamable.com'];

/** SPRITYREELS_LINK_HOSTS replaces the default list: comma-separated host names (each also matches its subdomains), or * for any public host. */
export function linkHosts(value = process.env.SPRITYREELS_LINK_HOSTS) {
  const list = (value ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : DEFAULT_LINK_HOSTS;
}

/** True for any address that is not a public internet address: loopback, private, link-local, shared, multicast, reserved. */
export function privateAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (kind === 6) {
    const x = address.toLowerCase();
    const dotted = /^(?:0*:)+ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (dotted) return privateAddress(dotted[1]);
    const hex = /^(?:0*:)+ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    const first = parseInt(x.split(':')[0] || '0', 16);
    return x === '::' || x === '::1' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || x.startsWith('2001:db8') || x.startsWith('64:ff9b');
  }
  return true;
}

type Resolve = (host: string) => Promise<{ address: string }[]>;
/** Throws an HttpError (400) unless the link may be handed to yt-dlp. */
export async function checkLink(raw: unknown, options: { hosts?: string[]; resolve?: Resolve } = {}) {
  const hosts = options.hosts ?? linkHosts(), resolve = options.resolve ?? ((host: string) => lookup(host, { all: true }));
  const bad = (message: string): never => { throw new HttpError(message, 400); };
  if (typeof raw !== 'string') return bad('Paste a full link that starts with https://.');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return bad('Paste a full link that starts with https://.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return bad('Only http and https links can be imported.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!hosts.includes('*')) return bad('Paste a link from a video site, or upload the file.');
    if (privateAddress(host)) return bad('That link points to a private address and cannot be imported.');
    return;
  }
  if (!hosts.includes('*') && !hosts.some(h => host === h || host.endsWith(`.${h}`))) return bad('That site is not supported yet. Paste a YouTube, Vimeo, TikTok, Twitch, X, Instagram or Facebook link, or upload the file.');
  let addresses: { address: string }[];
  try { addresses = await resolve(host); } catch { return bad('That link could not be found. Check it and try again.'); }
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) return bad('That link points to a private address and cannot be imported.');
}
