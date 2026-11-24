const IS_INPUT_TARGET = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
};

export function installStrictPrivacyShield(
  onNotify: (message: string) => void,
  onDevToolsStateChange: (open: boolean) => void
): () => void {
  let lastWarningAt = 0;
  const warn = (msg: string) => {
    const now = Date.now();
    if (now - lastWarningAt > 1200) {
      lastWarningAt = now;
      onNotify(msg);
    }
  };

  // Silence console logging methods so runtime objects/URLs cannot be dumped
  const originalConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    table: console.table,
    dir: console.dir,
  };
  const noop = () => {};
  try {
    console.log = noop;
    console.info = noop;
    console.debug = noop;
    console.table = noop;
    console.dir = noop;
  } catch {
    // ignore read-only console properties
  }

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    warn('Content protected · Right-click is disabled');
  };

  const onClipboardBlock = (e: ClipboardEvent) => {
    if (e.type === 'paste' && IS_INPUT_TARGET(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    warn('Content protected · Copying is disabled');
  };

  const onSelectStart = (e: Event) => {
    if (IS_INPUT_TARGET(e.target)) return;
    e.preventDefault();
  };

  const onDragStart = (e: DragEvent) => {
    e.preventDefault();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    const ctrlOrMeta = e.ctrlKey || e.metaKey;

    const isDevToolsKey =
      e.key === 'F12' ||
      (ctrlOrMeta &&
        e.shiftKey &&
        ['i', 'j', 'c', 'k', 'm', 'e'].includes(k)) ||
      (ctrlOrMeta && e.altKey && ['i', 'j', 'c', 'u'].includes(k)) ||
      (ctrlOrMeta && ['u', 's', 'p'].includes(k));

    if (isDevToolsKey) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      warn('Protected view · Source & developer tools are disabled');
      return;
    }

    if (
      ctrlOrMeta &&
      !IS_INPUT_TARGET(e.target) &&
      ['c', 'x', 'a'].includes(k)
    ) {
      e.preventDefault();
      e.stopPropagation();
      warn('Content protected · Copying is disabled');
    }
  };

  // Detect DevTools via top-level window viewport delta & console probe
  let devToolsActive = false;
  const checkDevTools = () => {
    let detected = false;

    // Only check outer/inner gap when running at top level (avoids false positives inside preview iframes or zoomed tabs)
    if (window.self === window.top) {
      const widthGap = window.outerWidth - window.innerWidth;
      const heightGap = window.outerHeight - window.innerHeight;
      if (widthGap > 260 || heightGap > 280) {
        detected = true;
      }
    }

    if (detected !== devToolsActive) {
      devToolsActive = detected;
      onDevToolsStateChange(detected);
    }
  };

  const intervalId = window.setInterval(checkDevTools, 900);

  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('copy', onClipboardBlock, true);
  document.addEventListener('cut', onClipboardBlock, true);
  document.addEventListener('selectstart', onSelectStart, true);
  document.addEventListener('dragstart', onDragStart, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', checkDevTools);

  return () => {
    window.clearInterval(intervalId);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('copy', onClipboardBlock, true);
    document.removeEventListener('cut', onClipboardBlock, true);
    document.removeEventListener('selectstart', onSelectStart, true);
    document.removeEventListener('dragstart', onDragStart, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', checkDevTools);
    try {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
      console.table = originalConsole.table;
      console.dir = originalConsole.dir;
    } catch {
      // ignore
    }
  };
}
