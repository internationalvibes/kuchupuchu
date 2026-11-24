import { MatchItem, StreamProtocol, StreamSource } from '../types';

interface RawStreamInput {
  channel_name?: string;
  stream_url?: string;
  kid?: string;
  key?: string;
}

interface RawMatchInput {
  event_name?: string;
  status?: string;
  Category?: string;
  eventInfo?: MatchItem['eventInfo'];
  streams?: RawStreamInput[];
}

interface RawFeedResponse {
  matches?: RawMatchInput[];
  live_match?: number;
  total_matches?: number;
  last_update_time?: string;
}

export interface ResolvedStreamSecret {
  stream_url: string;
  kid?: string;
  key?: string;
}

// Encoded feed reference kept private inside module closure
const _E = [
  'aHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL3NtLW1vbmly',
  'dWxpc2xhbS9VcGNvbWluZy1hbmQtTGl2ZS1TcG9ydHMtRGF0YS9tYWlu',
  'L1Nwb3J0c19kYXRhLmpzb24=',
];

function resolveFeedEndpoint(): string {
  return atob(_E.join(''));
}

// Private closure vault: raw URLs and ClearKey secrets never enter React state or DOM
const streamVault = new Map<string, ResolvedStreamSecret>();
const failedTokenIds = new Set<string>();
const workingTokenIds = new Set<string>();
let tokenCounter = 0;

function nextToken(): string {
  tokenCounter += 1;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ss_${tokenCounter}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `ss_${tokenCounter}_${Math.random().toString(36).slice(2, 10)}`;
}

function isSafeHttpUrl(value?: string): string {
  if (!value) return '';
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function inferProtocol(url: string): StreamProtocol {
  if (/\.mpd(?:$|\?)|\/mpd\b/i.test(url)) return 'DASH';
  if (/\.m3u8(?:$|\?)|[?&](?:extension|format)=m3u8|m3u8|load-playlist/i.test(url)) {
    return 'HLS';
  }
  return 'DIRECT';
}

export function isClearKeyEmeAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.isSecureContext) &&
    typeof navigator !== 'undefined' &&
    typeof navigator.requestMediaKeySystemAccess === 'function'
  );
}

function serverPlayabilityScore(
  url: string,
  protocol: StreamProtocol,
  hasDrm: boolean
): number {
  let score = 0;
  const isHttpsPage =
    typeof window !== 'undefined' && window.location.protocol === 'https:';
  // Push plain HTTP streams below HTTPS streams on HTTPS pages to prevent mixed-content blocks
  if (isHttpsPage && url.startsWith('http://')) {
    score += 100;
  }
  // Browser ClearKey EME requires HTTPS or http://localhost; deprioritize DRM streams if unavailable
  if (hasDrm && !isClearKeyEmeAvailable()) {
    score += 200;
  }
  if (protocol === 'HLS') score += 0;
  else if (protocol === 'DASH') score += 1;
  else score += 2;
  return score;
}

export async function fetchProtectedFeed(): Promise<{
  matches: MatchItem[];
  totalMatches: number | null;
  liveMatch: number | null;
  lastUpdateTime: string;
}> {
  const response = await fetch(resolveFeedEndpoint(), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Feed unavailable (${response.status})`);
  }

  const raw: RawFeedResponse | RawMatchInput[] = await response.json();
  const rawList = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.matches)
      ? raw.matches
      : [];

  streamVault.clear();
  failedTokenIds.clear();
  workingTokenIds.clear();

  const matches: MatchItem[] = rawList.map((m) => {
    const rawStreams = Array.isArray(m.streams) ? m.streams : [];
    const ranked: { stream: StreamSource; score: number; order: number }[] = [];

    rawStreams.forEach((s, order) => {
      const cleanUrl = isSafeHttpUrl(s.stream_url);
      if (!cleanUrl) return;
      const protocol = inferProtocol(cleanUrl);
      const hasDrm = Boolean(s.kid && s.key);
      const tokenId = nextToken();
      streamVault.set(tokenId, {
        stream_url: cleanUrl,
        kid: s.kid || undefined,
        key: s.key || undefined,
      });
      ranked.push({
        stream: {
          tokenId,
          channel_name: s.channel_name,
          protocol,
          hasDrm,
        },
        score: serverPlayabilityScore(cleanUrl, protocol, hasDrm),
        order,
      });
    });

    ranked.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.order - b.order));

    return {
      event_name: m.event_name,
      status: m.status,
      Category: m.Category,
      eventInfo: m.eventInfo,
      streams: ranked.map((r) => r.stream),
    };
  });

  if (Array.isArray(raw)) {
    return {
      matches,
      totalMatches: null,
      liveMatch: null,
      lastUpdateTime: '',
    };
  }

  return {
    matches,
    totalMatches: typeof raw.total_matches === 'number' ? raw.total_matches : null,
    liveMatch: typeof raw.live_match === 'number' ? raw.live_match : null,
    lastUpdateTime: raw.last_update_time || '',
  };
}

export function resolveStreamSecret(tokenId?: string): ResolvedStreamSecret | null {
  if (!tokenId) return null;
  const secret = streamVault.get(tokenId);
  return secret ? { ...secret } : null;
}

export function markServerWorking(tokenId?: string): void {
  if (!tokenId) return;
  failedTokenIds.delete(tokenId);
  workingTokenIds.add(tokenId);
}

export function markServerFailed(tokenId?: string): void {
  if (!tokenId) return;
  workingTokenIds.delete(tokenId);
  failedTokenIds.add(tokenId);
}

export function isServerKnownFailed(tokenId?: string): boolean {
  return Boolean(tokenId && failedTokenIds.has(tokenId));
}

export function pickDefaultServerIndex(sources: StreamSource[]): number {
  if (!sources.length) return 0;
  const emeReady = isClearKeyEmeAvailable();
  const workingIdx = sources.findIndex(
    (s) => workingTokenIds.has(s.tokenId) && (emeReady || !s.hasDrm)
  );
  if (workingIdx >= 0) return workingIdx;
  const untriedIdx = sources.findIndex(
    (s) => !failedTokenIds.has(s.tokenId) && (emeReady || !s.hasDrm)
  );
  if (untriedIdx >= 0) return untriedIdx;
  const fallbackUntried = sources.findIndex((s) => !failedTokenIds.has(s.tokenId));
  return fallbackUntried >= 0 ? fallbackUntried : 0;
}
