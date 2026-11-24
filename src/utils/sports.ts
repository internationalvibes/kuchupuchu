import { MatchItem, MatchStatusType, SportTab, StreamProtocol, StreamSource } from '../types';

export const BRAND_LOGO_URL = 'https://i.ibb.co/BTM5dLF/sportssnap-logo.png';

export const PRIORITY_CATEGORY = 'cricket';
export const SECOND_PRIORITY_CATEGORY = 'football';

export function safeUrl(value?: string): string {
  if (!value) return '';
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

export function matchStatus(m: MatchItem): MatchStatusType {
  const status = String(m.status || '').trim().toUpperCase();
  if (status === 'LIVE') return 'LIVE';
  if (status === 'ENDED' || status === 'FINISHED' || status === 'COMPLETED') {
    return 'ENDED';
  }
  return 'UPCOMING';
}

export function isLive(m: MatchItem): boolean {
  return matchStatus(m) === 'LIVE';
}

export function isCricket(m: MatchItem): boolean {
  return String(m.Category || '').trim().toLowerCase() === PRIORITY_CATEGORY;
}

export function isFootball(m: MatchItem): boolean {
  return String(m.Category || '').trim().toLowerCase() === SECOND_PRIORITY_CATEGORY;
}

export function categoryPriorityRank(category?: string): number {
  const normalized = String(category || '').trim().toLowerCase();
  if (normalized === PRIORITY_CATEGORY) return 0;
  if (normalized === SECOND_PRIORITY_CATEGORY) return 1;
  return 2;
}

export function sportTabOf(m: MatchItem): SportTab {
  if (isCricket(m)) return 'CRICKET';
  if (isFootball(m)) return 'FOOTBALL';
  return 'OTHERS';
}

export function streamsOf(m: MatchItem): StreamSource[] {
  return Array.isArray(m.streams) ? m.streams : [];
}

export function validStreams(m: MatchItem): StreamSource[] {
  return streamsOf(m).filter((s) => Boolean(s.tokenId));
}

export function eventName(m: MatchItem): string {
  const info = m.eventInfo || {};
  return info.eventName || m.event_name || 'Sports Event';
}

export function teamA(m: MatchItem): string {
  const info = m.eventInfo || {};
  return (
    info.teamA ||
    String(m.event_name || '').split(/\s+Vs\s+/i)[0]?.trim() ||
    eventName(m)
  );
}

export function teamB(m: MatchItem): string {
  const info = m.eventInfo || {};
  return (
    info.teamB ||
    String(m.event_name || '').split(/\s+Vs\s+/i)[1]?.trim() ||
    ''
  );
}

export function timeText(m: MatchItem): string {
  const info = m.eventInfo || {};
  return info.startTime || 'Schedule TBD';
}

export function getInitials(name: string): string {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  return parts
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}

export function detectProtocol(stream: StreamSource): StreamProtocol {
  return stream.protocol || 'DIRECT';
}

export function toClearKeyBase64Url(value: string): string {
  const trimmed = String(value || '').trim();
  const hex = trimmed.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    let bin = '';
    for (let i = 0; i < hex.length; i += 2) {
      bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function formatKidUuid(kid?: string): string {
  const hex = String(kid || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 32) return '';
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function patchMpdForClearKey(xml: string, fallbackKid?: string): string {
  const fallbackUuid = formatKidUuid(fallbackKid);
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror') || !doc.documentElement) {
      throw new Error('XML parse error');
    }

    const ns = doc.documentElement.namespaceURI || 'urn:mpeg:dash:schema:mpd:2011';
    const CENC_NS = 'urn:mpeg:cenc:2013';
    const WIDEVINE_URN = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
    const PLAYREADY_URN = '9a04f079-9840-4286-ab92-e65be0885f95';
    const CLEARKEY_URN = 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e';
    const W3C_CLEARKEY_ID = '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b';
    const MP4_PROT_URN = 'urn:mpeg:dash:mp4protection:2011';

    // Remove Widevine & PlayReady ContentProtection nodes anywhere in MPD
    const allCp = Array.from(doc.getElementsByTagNameNS('*', 'ContentProtection'));
    for (const el of allCp) {
      const uri = (el.getAttribute('schemeIdUri') || '').toLowerCase();
      if (uri.includes(WIDEVINE_URN) || uri.includes(PLAYREADY_URN)) {
        el.parentNode?.removeChild(el);
      }
    }

    // Ensure every AdaptationSet directly carries mp4protection + ClearKey ContentProtection
    // because dash.js getContentProtectionByAdaptation() only inspects AdaptationSet children
    const adaptationSets = Array.from(doc.getElementsByTagNameNS('*', 'AdaptationSet'));
    for (const asEl of adaptationSets) {
      const directChildren = Array.from(asEl.children).filter(
        (c) => c.localName === 'ContentProtection'
      );
      const descendantCps = Array.from(asEl.getElementsByTagNameNS('*', 'ContentProtection'));

      let detectedKid = fallbackUuid;
      for (const cp of descendantCps) {
        const kidAttr =
          cp.getAttributeNS(CENC_NS, 'default_KID') ||
          cp.getAttribute('cenc:default_KID') ||
          cp.getAttribute('default_KID');
        if (kidAttr) {
          detectedKid = kidAttr;
          break;
        }
      }

      const hasMp4Prot = directChildren.some(
        (c) => (c.getAttribute('schemeIdUri') || '').toLowerCase() === MP4_PROT_URN
      );
      const hasClearKey = directChildren.some((c) => {
        const u = (c.getAttribute('schemeIdUri') || '').toLowerCase();
        return u.includes('e2719d58-a985-b3c9-781a-b030af78d30e') || u.includes(W3C_CLEARKEY_ID);
      });

      const firstRep = Array.from(asEl.children).find(
        (c) => c.localName === 'Representation' || c.localName === 'SegmentTemplate'
      ) || null;

      if (!hasMp4Prot && detectedKid) {
        const mp4El = doc.createElementNS(ns, 'ContentProtection');
        mp4El.setAttribute('schemeIdUri', MP4_PROT_URN);
        mp4El.setAttribute('value', 'cenc');
        mp4El.setAttribute('xmlns:cenc', CENC_NS);
        mp4El.setAttribute('cenc:default_KID', detectedKid);
        asEl.insertBefore(mp4El, firstRep);
      }

      if (!hasClearKey) {
        const ckEl = doc.createElementNS(ns, 'ContentProtection');
        ckEl.setAttribute('schemeIdUri', CLEARKEY_URN);
        asEl.insertBefore(ckEl, firstRep);
      }
    }

    return new XMLSerializer().serializeToString(doc);
  } catch {
    let patched = xml.replace(
      /<ContentProtection[^>]*?(?:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|9a04f079-9840-4286-ab92-e65be0885f95)[^>]*?(?:\/>|>[\s\S]*?<\/ContentProtection>)/gi,
      ''
    );
    const mp4Tag = fallbackUuid
      ? `<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="${fallbackUuid}" xmlns:cenc="urn:mpeg:cenc:2013"/>`
      : '';
    const ckTag = '<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"/>';
    patched = patched.replace(/<AdaptationSet\b[^>]*>/gi, (m) => `${m}${mp4Tag}${ckTag}`);
    return patched;
  }
}

export function formatPlayerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

export function getMatchSlug(m: MatchItem): string {
  const raw = m.event_name || eventName(m) || 'match';
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'match'
  );
}

export function buildMatchShareUrl(m: MatchItem): string {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('match', getMatchSlug(m));
    return url.toString();
  } catch {
    return '';
  }
}

export async function shareMatch(
  m: MatchItem,
  onNotify: (msg: string) => void
): Promise<void> {
  const title = m.event_name || eventName(m);
  const st = matchStatus(m);
  const text =
    st === 'LIVE'
      ? `Watch ${title} LIVE on Sports Snap`
      : st === 'UPCOMING'
        ? `${title} (${timeText(m)}) on Sports Snap`
        : `${title} on Sports Snap`;
  const url = buildMatchShareUrl(m);

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text, url });
      onNotify('Match shared');
      return;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
    }
  }

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(url || text);
      onNotify('Match share link copied');
      return;
    }
  } catch {
    // ignore clipboard block
  }

  onNotify(`Ready to share: ${title}`);
}
