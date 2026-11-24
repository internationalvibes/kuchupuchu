const AD_COOLDOWN_MS = 20_000;
const STORAGE_KEY = 'ss_ad_last_ts';

// Encoded direct-link ad endpoint inside module closure
const _A = [
  'aHR0cHM6Ly93d3cuZWZmZWN0aXZlY3BtbmV0d29yay5jb20veXhkcHFp',
  'ZXQ1P2tleT05MzA4OTQyNzRjM2U5ZTlkMjliNTc2MjE0MjJlOTA2ZA==',
];

function decodeAdEndpoint(): string {
  return atob(_A.join(''));
}

function shouldSkipTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, option'));
}

function readLastTrigger(): number {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeLastTrigger(ts: number): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(ts));
  } catch {
    // ignore storage restriction
  }
}

export function installClickTouchRedirectAd(): () => void {
  let lastTriggerAt = readLastTrigger();
  let lastTouchEndAt = 0;
  let touchStartX = 0;
  let touchStartY = 0;

  const triggerRedirectIfReady = () => {
    const now = Date.now();
    if (now - lastTriggerAt < AD_COOLDOWN_MS) return;

    lastTriggerAt = now;
    writeLastTrigger(now);

    try {
      const anchor = document.createElement('a');
      anchor.href = decodeAdEndpoint();
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      // ignore blocked navigation
    }
  };

  const onTouchStart = (e: TouchEvent) => {
    if (!e.isTrusted || !e.touches.length) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!e.isTrusted || shouldSkipTarget(e.target)) return;
    if (e.changedTouches && e.changedTouches.length) {
      const dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
      const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
      // Ignore scroll/swipe gestures
      if (dx > 12 || dy > 12) return;
    }
    lastTouchEndAt = Date.now();
    triggerRedirectIfReady();
  };

  const onClick = (e: MouseEvent) => {
    if (!e.isTrusted || shouldSkipTarget(e.target)) return;
    // Deduplicate synthetic click fired shortly after mobile touchend
    if (Date.now() - lastTouchEndAt < 750) return;
    triggerRedirectIfReady();
  };

  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  document.addEventListener('click', onClick, { capture: true, passive: true });

  return () => {
    document.removeEventListener('touchstart', onTouchStart, { capture: true });
    document.removeEventListener('touchend', onTouchEnd, { capture: true });
    document.removeEventListener('click', onClick, { capture: true });
  };
}
