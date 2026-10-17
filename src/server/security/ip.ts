import dns from 'node:dns';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import type { TlsMaxVersion } from './types.js';
import { SecurityError } from './errors.js';

export interface LookupAddress {
  address: string;
  family: 4 | 6;
}

export type DnsLookup = (
  hostname: string,
  options: {
    all: true;
    verbatim: true
  },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

export type SsrSafeLookup = LookupFunction;

export interface SsrSafeLookupOptions {
  lookup?: DnsLookup;
}

const defaultLookup: DnsLookup = (hostname, options, callback) => {
  dns.lookup(hostname, options, (error, addresses) => {
    callback(
      error,
      addresses.map((address) => ({ address: address.address, family: address.family as 4 | 6 }))
    );
  });
};

const IPV4_BLOCKS: Array<[number, number]> = [
  [ipv4ToInt('0.0.0.0'), 8],
  [ipv4ToInt('10.0.0.0'), 8],
  [ipv4ToInt('100.64.0.0'), 10],
  [ipv4ToInt('127.0.0.0'), 8],
  [ipv4ToInt('169.254.0.0'), 16],
  [ipv4ToInt('172.16.0.0'), 12],
  [ipv4ToInt('192.168.0.0'), 16],
  [ipv4ToInt('192.0.0.0'), 24],
  [ipv4ToInt('198.18.0.0'), 15],
  [ipv4ToInt('224.0.0.0'), 4],
  [ipv4ToInt('240.0.0.0'), 4]
];

const IPV6_BLOCKS: Array<[bigint, number]> = [
  [ipv6ToBigInt('::1'), 128],
  [ipv6ToBigInt('::'), 128],
  [ipv6ToBigInt('fc00::'), 7],
  [ipv6ToBigInt('fe80::'), 10],
  [ipv6ToBigInt('ff00::'), 8],
  [ipv6ToBigInt('64:ff9b::'), 96]
];

export function assertSafeFeedUrl(value: string): URL {
  const url = parseHttpUrl(value);
  if (url.username || url.password) {
    throw new SecurityError('invalid_url', 'Feed URL must not contain credentials.');
  }
  assertHostnameSyntax(url.hostname);
  assertLiteralHostAllowed(url.hostname);
  return url;
}

export async function verifyFeedUrlSafe(value: string, options: SsrSafeLookupOptions = {}): Promise<URL> {
  const url = assertSafeFeedUrl(value);
  await resolveSafeHostname(url.hostname, options);
  return url;
}

export async function resolveSafeHostname(hostname: string, options: SsrSafeLookupOptions = {}): Promise<LookupAddress[]> {
  const normalized = normalizeHostname(hostname);
  assertHostnameSyntax(normalized);

  const literalFamily = net.isIP(normalized);
  if (literalFamily !== 0) {
    assertAddressAllowed(normalized);
    return [{ address: normalized, family: literalFamily as 4 | 6 }];
  }

  const lookup = options.lookup ?? defaultLookup;
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    lookup(normalized, { all: true, verbatim: true }, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });

  if (addresses.length === 0) {
    throw new SecurityError('ssrf_blocked', 'Host did not resolve to an address.');
  }

  // 하나라도 내부 주소가 섞여 있으면 거부한다. 실제 연결에서 어느 주소가 선택될지에 의존하지 않는다.
  for (const address of addresses) {
    assertAddressAllowed(address.address);
  }
  return addresses;
}

export function createSsrSafeLookup(options: SsrSafeLookupOptions = {}): SsrSafeLookup {
  // 사전 검사에 더해 실제 소켓 연결 시점의 DNS 조회에도 동일한 검증을 적용한다.
  return (hostname, lookupOptions, callback) => {
    resolveSafeHostname(hostname, options)
      .then((addresses) => {
        if (lookupOptions.all) {
          callback(null, addresses);
          return;
        }
        const first = addresses[0];
        if (!first) {
          callback(new Error('Host did not resolve to an address.'), '');
          return;
        }
        callback(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        callback(toNodeError(error), '');
      });
  };
}

export function assertAddressAllowed(address: string): void {
  const normalized = normalizeHostname(address);
  if (normalized.includes('%')) {
    throw new SecurityError('ssrf_blocked', 'IPv6 zone identifiers are not allowed.');
  }

  const family = net.isIP(normalized);
  if (family === 4 && isRestrictedIpv4(normalized)) {
    throw new SecurityError('ssrf_blocked', 'Resolved address is not allowed.');
  }
  if (family === 6) {
    // IPv4를 담은 IPv6 표기로 사설 IPv4 차단을 우회하지 못하도록 내부 주소도 검사한다.
    const mapped = extractIpv4MappedAddress(normalized);
    if (mapped && isRestrictedIpv4(mapped)) {
      throw new SecurityError('ssrf_blocked', 'Resolved IPv4-mapped address is not allowed.');
    }
    if (isRestrictedIpv6(normalized)) {
      throw new SecurityError('ssrf_blocked', 'Resolved address is not allowed.');
    }
  }
  if (family === 0) {
    throw new SecurityError('invalid_url', 'Host is not a valid IP address.');
  }
}

export function parseHttpUrl(value: string): URL {
  if (value.length > 2048) {
    throw new SecurityError('invalid_url', 'URL must be 2048 characters or shorter.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SecurityError('invalid_url', 'URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SecurityError('invalid_url', 'URL must use http or https.');
  }
  if (!url.hostname) {
    throw new SecurityError('invalid_url', 'URL must include a hostname.');
  }
  return url;
}

export function tlsProfileKey(tlsMaxVersion?: TlsMaxVersion): 'default' | TlsMaxVersion {
  return tlsMaxVersion ?? 'default';
}

function toNodeError(error: unknown): NodeJS.ErrnoException {
  if (error instanceof Error) return error as NodeJS.ErrnoException;
  return new Error(String(error)) as NodeJS.ErrnoException;
}

function assertHostnameSyntax(hostname: string): void {
  if (hostname.includes('%')) {
    throw new SecurityError('ssrf_blocked', 'IPv6 zone identifiers are not allowed.');
  }
}

function assertLiteralHostAllowed(hostname: string): void {
  const normalized = normalizeHostname(hostname);
  if (net.isIP(normalized) !== 0) {
    assertAddressAllowed(normalized);
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function isRestrictedIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  return IPV4_BLOCKS.some(([network, prefix]) => ipv4InCidr(value, network, prefix));
}

function isRestrictedIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  return IPV6_BLOCKS.some(([network, prefix]) => ipv6InCidr(value, network, prefix));
}

function extractIpv4MappedAddress(address: string): string | undefined {
  const value = ipv6ToBigInt(address);
  const mappedPrefix = ipv6ToBigInt('::ffff:0:0');
  const prefixMask = ipv6Mask(96);
  if ((value & prefixMask) !== (mappedPrefix & prefixMask)) return undefined;
  const last32 = Number(value & 0xffffffffn);
  return [24, 16, 8, 0].map((shift) => String((last32 >>> shift) & 0xff)).join('.');
}

function ipv4InCidr(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6InCidr(value: bigint, network: bigint, prefix: number): boolean {
  const mask = ipv6Mask(prefix);
  return (value & mask) === (network & mask);
}

function ipv6Mask(prefix: number): bigint {
  if (prefix === 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
}

function ipv4ToInt(address: string): number {
  const parts = address.split('.');
  if (parts.length !== 4) throw new SecurityError('invalid_url', 'Invalid IPv4 address.');
  return parts.reduce((acc, part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new SecurityError('invalid_url', 'Invalid IPv4 address.');
    }
    return ((acc << 8) | value) >>> 0;
  }, 0);
}

function ipv6ToBigInt(address: string): bigint {
  const normalized = normalizeHostname(address);
  if (normalized.includes('%')) {
    throw new SecurityError('ssrf_blocked', 'IPv6 zone identifiers are not allowed.');
  }

  const [head = '', tail = ''] = normalized.split('::');
  if (normalized.split('::').length > 2) {
    throw new SecurityError('invalid_url', 'Invalid IPv6 address.');
  }

  const headParts = parseIpv6Parts(head);
  const tailParts = parseIpv6Parts(tail);
  const fillLength = 8 - headParts.length - tailParts.length;
  if (fillLength < 0 || (!normalized.includes('::') && fillLength !== 0)) {
    throw new SecurityError('invalid_url', 'Invalid IPv6 address.');
  }

  const parts = [...headParts, ...Array.from({ length: fillLength }, () => 0), ...tailParts];
  if (parts.length !== 8) {
    throw new SecurityError('invalid_url', 'Invalid IPv6 address.');
  }
  return parts.reduce((acc, part) => (acc << 16n) | BigInt(part), 0n);
}

function parseIpv6Parts(value: string): number[] {
  if (value === '') return [];
  const rawParts = value.split(':');
  const result: number[] = [];
  for (const [index, part] of rawParts.entries()) {
    if (part.includes('.')) {
      if (index !== rawParts.length - 1) {
        throw new SecurityError('invalid_url', 'Invalid IPv6 address.');
      }
      const ipv4 = ipv4ToInt(part);
      result.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
      throw new SecurityError('invalid_url', 'Invalid IPv6 address.');
    }
    result.push(Number.parseInt(part, 16));
  }
  return result;
}
