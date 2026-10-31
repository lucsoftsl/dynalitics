import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { IpMode } from '../model/types.js';

export interface NormalizedIp {
  readonly family: 4 | 6;
  /** Canonical text: IPv4 dotted quad, IPv6 lower-case and compressed. */
  readonly text: string;
}
export interface IpConfig {
  readonly mode: IpMode;
  readonly salt: string | undefined;
  readonly ipv4Prefix: number;
  readonly ipv6Prefix: number;
}

const MAX_INPUT = 64;
const V6_BITS = 128n;
const V6_ALL = (1n << V6_BITS) - 1n;

function v6ToBigInt(text: string): bigint {
  let s = text;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.slice(1).map(Number);
    s = `${s.slice(0, s.length - tail[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = s.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = rest === undefined || rest === '' ? [] : rest.split(':');
  const groups =
    rest === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(`0x${g}`), 0n);
}

function formatV6(n: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(16 * (7 - i))) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) [bestStart, bestLen] = [i, j - i];
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/** Strips ports, brackets, zone ids and IPv4-mapped prefixes; returns null for anything that is not an IP address. */
export function normalizeIp(input: string): NormalizedIp | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT) return null;
  let s = input.trim();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracket?.[1] !== undefined) s = bracket[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  s = s.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped?.[1] !== undefined) s = mapped[1];
  const family = isIP(s);
  if (family === 4) return { family: 4, text: s };
  if (family === 6) return { family: 6, text: formatV6(v6ToBigInt(s)) };
  return null;
}

function truncate(ip: NormalizedIp, cfg: IpConfig): string {
  if (ip.family === 4) {
    const n = ip.text.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
    const hostBits = 32 - cfg.ipv4Prefix;
    const masked = hostBits === 0 ? n : Math.floor(n / 2 ** hostBits) * 2 ** hostBits;
    return [24, 16, 8, 0].map((shift) => Math.floor(masked / 2 ** shift) % 256).join('.');
  }
  const mask = V6_ALL ^ ((1n << BigInt(128 - cfg.ipv6Prefix)) - 1n);
  return formatV6(v6ToBigInt(ip.text) & mask);
}

/** The stored form of an address under the configured mode (spec 8.3). */
export function applyIpMode(ip: NormalizedIp, cfg: IpConfig): string {
  switch (cfg.mode) {
    case 'raw':
      return ip.text;
    case 'truncate':
      return truncate(ip, cfg);
    case 'hash':
      if (cfg.salt === undefined) throw new Error('ip.salt is required for ip.mode "hash"');
      return createHmac('sha256', cfg.salt).update(ip.text).digest('hex');
  }
}
