import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import * as dashjs from 'dashjs';
import {
  Camera,
  Maximize2,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  Radio,
  RotateCcw,
  RotateCw,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Tv,
  Volume2,
  VolumeX,
  X,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import {
  AspectFitMode,
  AudioTrackOption,
  MatchItem,
  PlayerTelemetry,
  QualityOption,
  StreamSource,
} from '../types';
import {
  BRAND_LOGO_URL,
  detectProtocol,
  eventName,
  formatPlayerTime,
  patchMpdForClearKey,
  shareMatch,
  toClearKeyBase64Url,
  validStreams,
} from '../utils/sports';
import {
  isClearKeyEmeAvailable,
  markServerFailed,
  markServerWorking,
  pickDefaultServerIndex,
  resolveStreamSecret,
} from '../utils/streamVault';

interface SportsSnapPlayerProps {
  match: MatchItem | null;
  onClose: () => void;
  onNotify: (message: string) => void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export const SportsSnapPlayer: React.FC<SportsSnapPlayerProps> = ({
  match,
  onClose,
  onNotify,
}) => {
  const sources = useMemo(() => (match ? validStreams(match) : []), [match]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<'sources' | 'controls'>('sources');
  const [theaterMode, setTheaterMode] = useState(false);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [isLiveStream, setIsLiveStream] = useState(true);
  const [behindLive, setBehindLive] = useState(false);

  // Audio & Speed
  const [volume, setVolume] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('ss_player_volume');
      return saved !== null ? Math.min(1, Math.max(0, Number(saved))) : 0.85;
    } catch {
      return 0.85;
    }
  });
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);

  // Quality, Audio Tracks, Aspect
  const [qualities, setQualities] = useState<QualityOption[]>([
    { index: -1, label: 'Auto' },
  ]);
  const [selectedQuality, setSelectedQuality] = useState<number>(-1);
  const [audioTracks, setAudioTracks] = useState<AudioTrackOption[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<number>(0);
  const [aspectMode, setAspectMode] = useState<AspectFitMode>('contain');

  // Picture tuning & engine options
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const [lowLatency, setLowLatency] = useState(true);
  const [autoRecover, setAutoRecover] = useState(true);

  // UI & Fullscreen
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Real playback telemetry
  const [telemetry, setTelemetry] = useState<PlayerTelemetry>({
    protocol: 'HLS',
    resolution: '—',
    bitrateMbps: 'Auto',
    bufferSeconds: 0,
    droppedFrames: 0,
    playbackState: 'Connecting',
  });

  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const loadWatchdogRef = useRef<number | null>(null);
  const autoDiscoverRef = useRef<boolean>(true);
  const triedAutoRef = useRef<Set<number>>(new Set());
  const playbackConfirmedRef = useRef<boolean>(false);

  const activeSource: StreamSource | undefined = sources[activeIndex];

  // Reset source index to best default playable server when opening a new match
  useEffect(() => {
    const defaultIdx = pickDefaultServerIndex(sources);
    setActiveIndex(defaultIdx);
    setActiveTab('sources');
    setStreamError(null);
    setPlaybackRate(1);
    setReloadNonce(0);
    autoDiscoverRef.current = true;
    triedAutoRef.current = new Set([defaultIdx]);
    playbackConfirmedRef.current = false;
  }, [match, sources]);

  const clearLoadWatchdog = useCallback(() => {
    if (loadWatchdogRef.current) {
      window.clearTimeout(loadWatchdogRef.current);
      loadWatchdogRef.current = null;
    }
  }, []);

  const advanceToNextPlayableServer = useCallback(
    (failedTokenId: string): boolean => {
      markServerFailed(failedTokenId);
      if (!autoDiscoverRef.current || sources.length <= 1) return false;
      const nextIdx = sources.findIndex((_, i) => !triedAutoRef.current.has(i));
      if (nextIdx < 0) {
        autoDiscoverRef.current = false;
        return false;
      }
      triedAutoRef.current.add(nextIdx);
      setActiveIndex(nextIdx);
      onNotify(`Switching to ${sources[nextIdx]?.channel_name || `Server ${nextIdx + 1}`}…`);
      return true;
    },
    [sources, onNotify]
  );

  const confirmPlaybackWorking = useCallback(() => {
    clearLoadWatchdog();
    playbackConfirmedRef.current = true;
    autoDiscoverRef.current = false;
    if (activeSource?.tokenId) {
      markServerWorking(activeSource.tokenId);
    }
  }, [activeSource, clearLoadWatchdog]);

  const scheduleHideControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setControlsVisible(false);
      }
    }, 3200);
  }, []);

  const destroyInstances = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (dashRef.current) {
      try {
        dashRef.current.reset();
      } catch {
        // ignore reset error
      }
      dashRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }, []);

  // Initialize stream when activeSource, lowLatency, or reloadNonce changes
  useEffect(() => {
    if (!match || !activeSource || !videoRef.current) return;

    const video = videoRef.current;
    const secret = resolveStreamSecret(activeSource.tokenId);
    if (!secret) {
      if (!advanceToNextPlayableServer(activeSource.tokenId)) {
        setIsBuffering(false);
        setStreamError('Protected stream feed unavailable.');
      }
      return;
    }
    const url = secret.stream_url;
    const protocol = detectProtocol(activeSource);
    const hasClearKey = Boolean(secret.kid && secret.key);

    clearLoadWatchdog();
    destroyInstances();
    playbackConfirmedRef.current = false;
    setIsBuffering(true);
    setStreamError(null);
    setQualities([{ index: -1, label: 'Auto' }]);
    setSelectedQuality(-1);
    setAudioTracks([]);
    setSelectedAudio(0);
    setCurrentTime(0);
    setDuration(0);
    setBufferedEnd(0);
    setTelemetry({
      protocol:
        activeSource.hasDrm || hasClearKey
          ? `${protocol} · ClearKey DRM`
          : protocol,
      resolution: '—',
      bitrateMbps: 'Auto',
      bufferSeconds: 0,
      droppedFrames: 0,
      playbackState: 'Initializing',
    });

    // If auto-discovering playable server on open, advance if stalled past 7s
    if (autoDiscoverRef.current && sources.length > 1) {
      const tokenForTimeout = activeSource.tokenId;
      loadWatchdogRef.current = window.setTimeout(() => {
        if (!playbackConfirmedRef.current) {
          advanceToNextPlayableServer(tokenForTimeout);
        }
      }, 7000);
    }

    video.volume = volume;
    video.muted = isMuted;
    video.playbackRate = playbackRate;

    if (protocol === 'DASH') {
      if (hasClearKey && !isClearKeyEmeAvailable()) {
        clearLoadWatchdog();
        if (advanceToNextPlayableServer(activeSource.tokenId)) return;
        setIsBuffering(false);
        setStreamError(
          'ClearKey DASH DRM requires HTTPS or http://localhost (browser DRM is blocked on file://, LAN IP, or plain http://). Open at http://localhost or host over HTTPS, or pick an HLS server below.'
        );
        return;
      }

      try {
        const player = dashjs.MediaPlayer().create();
        dashRef.current = player;
        player.updateSettings({
          streaming: {
            delay: {
              liveDelay: lowLatency ? 6 : 12,
            },
            gaps: {
              jumpGaps: true,
              jumpLargeGaps: true,
              smallGapLimit: 2.5,
              enableStallFix: true,
            },
            ...(hasClearKey
              ? {
                  protection: {
                    ignoreEmeEncryptedEvent: true,
                  },
                }
              : {}),
          },
        });

        player.initialize(video, undefined as unknown as string, true);

        if (hasClearKey && secret.kid && secret.key) {
          const kidHex = secret.kid;
          const keyHex = secret.key;
          player.addResponseInterceptor(async (response) => {
            let xmlText = '';
            if (typeof response.data === 'string') {
              xmlText = response.data;
            } else if (response.data instanceof ArrayBuffer) {
              xmlText = new TextDecoder('utf-8').decode(response.data);
            }
            if (xmlText && xmlText.includes('<MPD')) {
              const patched = patchMpdForClearKey(xmlText, kidHex);
              response.data =
                response.data instanceof ArrayBuffer
                  ? new TextEncoder().encode(patched).buffer
                  : patched;
            }
            return response;
          });

          const kidB64 = toClearKeyBase64Url(kidHex);
          const keyB64 = toClearKeyBase64Url(keyHex);
          player.setProtectionData({
            'org.w3.clearkey': {
              priority: 0,
              clearkeys: { [kidB64]: keyB64 },
            },
          });
        }

        player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
          setIsBuffering(false);
          const reps = player.getRepresentationsByType('video') || [];
          const opts: QualityOption[] = [
            { index: -1, label: 'Auto' },
            ...reps
              .map((rep, idx) => ({
                index: rep.absoluteIndex ?? idx,
                label: rep.height
                  ? `${rep.height}p (${(rep.bandwidth / 1_000_000).toFixed(1)} Mbps)`
                  : `Track ${idx + 1}`,
                height: rep.height,
                bitrate: rep.bandwidth,
              }))
              .sort((a, b) => (b.height || 0) - (a.height || 0)),
          ];
          setQualities(opts);

          const aTracks = player.getTracksFor('audio') || [];
          setAudioTracks(
            aTracks.map((t, idx) => ({
              index: idx,
              label: t.lang ? `Audio (${t.lang.toUpperCase()})` : `Audio ${idx + 1}`,
              lang: t.lang ?? undefined,
            }))
          );
        });

        player.on(dashjs.MediaPlayer.events.ERROR, () => {
          if (advanceToNextPlayableServer(activeSource.tokenId)) return;
          setIsBuffering(false);
          setStreamError('Unable to decode this DASH server. Try another server.');
        });

        player.attachSource(url);
      } catch {
        if (advanceToNextPlayableServer(activeSource.tokenId)) return;
        setIsBuffering(false);
        setStreamError('DASH engine failed to initialize for this server.');
      }
    } else if (protocol === 'HLS' && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: lowLatency,
        backBufferLength: 30,
      });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
        setIsBuffering(false);
        const levels = data.levels || [];
        const opts: QualityOption[] = [
          { index: -1, label: 'Auto' },
          ...levels
            .map((lvl, idx) => ({
              index: idx,
              label: lvl.height
                ? `${lvl.height}p (${(lvl.bitrate / 1_000_000).toFixed(1)} Mbps)`
                : `Level ${idx + 1}`,
              height: lvl.height,
              bitrate: lvl.bitrate,
            }))
            .sort((a, b) => (b.height || 0) - (a.height || 0)),
        ];
        setQualities(opts);
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_evt, data) => {
        const tracks = data.audioTracks || [];
        setAudioTracks(
          tracks.map((t, idx) => ({
            index: idx,
            label: t.name || (t.lang ? `Audio (${t.lang.toUpperCase()})` : `Track ${idx + 1}`),
            lang: t.lang,
          }))
        );
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (autoDiscoverRef.current && sources.length > 1) {
          if (advanceToNextPlayableServer(activeSource.tokenId)) return;
        }
        if (autoRecover) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
        }
        setIsBuffering(false);
        setStreamError('Server connection failed or blocked. Try another server.');
      });
    } else {
      video.src = url;
      video.play().catch(() => {});
    }

    return () => {
      clearLoadWatchdog();
      destroyInstances();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, activeSource, lowLatency, reloadNonce, destroyInstances, clearLoadWatchdog]);

  // Sync volume & playback rate with video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
    try {
      localStorage.setItem('ss_player_volume', String(volume));
    } catch {
      // ignore storage errors
    }
  }, [volume, isMuted]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Real telemetry & progress polling
  useEffect(() => {
    if (!match) return;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;

      const cur = video.currentTime || 0;
      const dur = video.duration;
      const seekableEnd =
        video.seekable && video.seekable.length > 0
          ? video.seekable.end(video.seekable.length - 1)
          : 0;

      const live = !Number.isFinite(dur) || dur === Infinity;
      setIsLiveStream(live);
      setCurrentTime(cur);
      setDuration(live ? seekableEnd : dur || 0);

      let bufAhead = 0;
      let bufEnd = 0;
      if (video.buffered && video.buffered.length > 0) {
        for (let i = 0; i < video.buffered.length; i++) {
          const start = video.buffered.start(i);
          const end = video.buffered.end(i);
          if (cur >= start - 0.5 && cur <= end + 0.5) {
            bufAhead = Math.max(0, end - cur);
            bufEnd = end;
            break;
          }
        }
      }
      setBufferedEnd(bufEnd);
      setBehindLive(live && seekableEnd > 0 && seekableEnd - cur > 12);

      const q = video.getVideoPlaybackQuality
        ? video.getVideoPlaybackQuality()
        : null;
      const resolution =
        video.videoWidth && video.videoHeight
          ? `${video.videoWidth}x${video.videoHeight}`
          : '—';

      let bitrateLabel = 'Auto';
      if (hlsRef.current) {
        const lvlIdx = hlsRef.current.currentLevel;
        const lvl = hlsRef.current.levels?.[lvlIdx];
        if (lvl?.bitrate) {
          bitrateLabel = `${(lvl.bitrate / 1_000_000).toFixed(2)} Mbps`;
        }
      } else if (dashRef.current) {
        try {
          const rep = dashRef.current.getCurrentRepresentationForType('video');
          if (rep?.bandwidth) {
            bitrateLabel = `${(rep.bandwidth / 1_000_000).toFixed(2)} Mbps`;
          }
        } catch {
          // ignore
        }
      }

      if (
        dashRef.current &&
        !video.paused &&
        video.readyState < 3 &&
        video.buffered &&
        video.buffered.length > 0
      ) {
        let insideBuffered = false;
        for (let i = 0; i < video.buffered.length; i++) {
          if (
            cur >= video.buffered.start(i) - 0.25 &&
            cur <= video.buffered.end(i) + 0.25
          ) {
            insideBuffered = true;
            break;
          }
        }
        if (!insideBuffered) {
          const targetIdx = video.buffered.length - 1;
          const bStart = video.buffered.start(targetIdx);
          const bEnd = video.buffered.end(targetIdx);
          if (bEnd - bStart >= 0.3) {
            video.currentTime = bStart + 0.05;
            video.play().catch(() => {});
          }
        }
      }

      setTelemetry((prev) => ({
        ...prev,
        resolution,
        bitrateMbps: bitrateLabel,
        bufferSeconds: Number(bufAhead.toFixed(1)),
        droppedFrames: q ? q.droppedVideoFrames : 0,
        playbackState: streamError
          ? 'Error'
          : video.paused
            ? 'Paused'
            : video.readyState < 3
              ? 'Buffering'
              : 'Playing',
      }));
    }, 500);

    return () => window.clearInterval(interval);
  }, [match, streamError]);

  // Fullscreen listener
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
    scheduleHideControls();
  }, [scheduleHideControls]);

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      const target = Math.max(0, video.currentTime + delta);
      if (Number.isFinite(video.duration)) {
        video.currentTime = Math.min(video.duration, target);
      } else if (video.seekable && video.seekable.length > 0) {
        const max = video.seekable.end(video.seekable.length - 1);
        video.currentTime = Math.min(max, target);
      } else {
        video.currentTime = target;
      }
      scheduleHideControls();
    },
    [scheduleHideControls]
  );

  const jumpToLive = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (hlsRef.current && hlsRef.current.liveSyncPosition) {
      video.currentTime = hlsRef.current.liveSyncPosition;
    } else if (video.seekable && video.seekable.length > 0) {
      video.currentTime = video.seekable.end(video.seekable.length - 1);
    }
    video.play().catch(() => {});
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((m) => !m);
    scheduleHideControls();
  }, [scheduleHideControls]);

  const toggleFullscreen = useCallback(async () => {
    const el = stageRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      onNotify('Fullscreen unavailable in this browser');
    }
  }, [onNotify]);

  const togglePiP = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
      } else {
        onNotify('Picture-in-Picture is not supported');
      }
    } catch {
      onNotify('Unable to enter Picture-in-Picture');
    }
  }, [onNotify]);

  const captureSnap = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      onNotify('Wait for video frame before taking a snap');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      const slug = (match?.event_name || 'live')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40);
      a.download = `sports-snap-${slug}.png`;
      a.click();
      onNotify('Snapshot saved');
    } catch {
      onNotify('Snapshot blocked by stream CORS policy');
    }
  }, [brightness, contrast, saturation, match, onNotify]);

  const handleQualityChange = (idx: number) => {
    setSelectedQuality(idx);
    if (hlsRef.current) {
      hlsRef.current.currentLevel = idx;
    } else if (dashRef.current) {
      if (idx === -1) {
        dashRef.current.updateSettings({
          streaming: { abr: { autoSwitchBitrate: { video: true } } },
        });
      } else {
        dashRef.current.updateSettings({
          streaming: { abr: { autoSwitchBitrate: { video: false } } },
        });
        dashRef.current.setRepresentationForTypeByIndex('video', idx);
      }
    }
    const chosen = qualities.find((q) => q.index === idx);
    onNotify(`Quality: ${chosen ? chosen.label : 'Auto'}`);
  };

  const handleAudioChange = (idx: number) => {
    setSelectedAudio(idx);
    if (hlsRef.current) {
      hlsRef.current.audioTrack = idx;
    } else if (dashRef.current) {
      const tracks = dashRef.current.getTracksFor('audio');
      if (tracks?.[idx]) dashRef.current.setCurrentTrack(tracks[idx]);
    }
  };

  const handleNextSource = () => {
    if (sources.length <= 1) return;
    setActiveIndex((prev) => (prev + 1) % sources.length);
  };

  // Keyboard shortcuts while player is open
  useEffect(() => {
    if (!match) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        if (document.fullscreenElement) return;
        onClose();
      } else if (e.key === ' ' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key.toLowerCase() === 'm') {
        toggleMute();
      } else if (e.key.toLowerCase() === 'f') {
        toggleFullscreen();
      } else if (e.key.toLowerCase() === 'p') {
        togglePiP();
      } else if (e.key.toLowerCase() === 't') {
        setTheaterMode((t) => !t);
      } else if (e.key.toLowerCase() === 's') {
        captureSnap();
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') {
        seekBy(-10);
      } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
        seekBy(10);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    match,
    onClose,
    togglePlay,
    toggleMute,
    toggleFullscreen,
    togglePiP,
    captureSnap,
    seekBy,
  ]);

  if (!match) return null;

  const progressPct =
    duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const bufferedPct =
    duration > 0 ? Math.min(100, Math.max(0, (bufferedEnd / duration) * 100)) : 0;

  const videoFitClass =
    aspectMode === 'cover'
      ? 'object-cover'
      : aspectMode === '16:9'
        ? 'object-fill aspect-video'
        : aspectMode === '4:3'
          ? 'object-fill aspect-[4/3]'
          : 'object-contain';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Sports Snap Player — ${match.event_name || eventName(match)}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`flex flex-col w-full bg-[#10141b] border border-[#242b38] rounded-xl overflow-hidden shadow-2xl transition-all duration-200 ${
          theaterMode ? 'max-w-[1440px] h-[94vh]' : 'max-w-[1240px] max-h-[94vh]'
        }`}
      >
        {/* Branded Sports Snap Player Header */}
        <header className="flex items-center justify-between gap-4 px-4 py-3 bg-[#141922] border-b border-[#232a36]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 shrink-0">
              <img
                src={BRAND_LOGO_URL}
                alt="Sports Snap"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                  const fb = e.currentTarget.nextElementSibling as HTMLElement | null;
                  if (fb) fb.style.display = 'inline-flex';
                }}
                className="h-9 sm:h-10 w-auto object-contain"
              />
              <span
                style={{ display: 'none' }}
                className="items-center gap-2 font-display text-xl font-bold tracking-tight text-white whitespace-nowrap"
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#10b981] text-[#090b0e]">
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 fill-current"
                    aria-hidden="true"
                  >
                    <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
                  </svg>
                </span>
                <span>Sports Snap</span>
              </span>
            </div>

            <span className="text-[#3a4558] hidden sm:inline" aria-hidden="true">
              /
            </span>

            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[#f3f5f8] truncate">
                {match.event_name || eventName(match)}
              </h2>
              <div className="flex items-center gap-2 text-xs text-[#8e9aaf] truncate">
                <span className="inline-flex items-center gap-1.5 text-[#f87171] font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444]" />
                  LIVE
                </span>
                <span aria-hidden="true">·</span>
                <span className="truncate">
                  {activeSource?.channel_name || `Channel ${activeIndex + 1}`}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[11px]">{telemetry.protocol}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => shareMatch(match, onNotify)}
              title="Share Match"
              aria-label="Share Match"
              className="h-9 px-2.5 rounded-lg border border-[#252d3b] bg-[#181e28] text-[#cbd5e1] hover:text-white hover:border-[#394559] transition-colors inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap cursor-pointer"
            >
              <Share2 className="w-3.5 h-3.5 text-[#10b981]" />
              <span className="hidden md:inline">Share</span>
            </button>
            <button
              type="button"
              onClick={() => {
                autoDiscoverRef.current = false;
                setReloadNonce((n) => n + 1);
              }}
              title="Reload Stream"
              className="h-9 px-2.5 rounded-lg border border-[#252d3b] bg-[#181e28] text-[#cbd5e1] hover:text-white hover:border-[#394559] transition-colors inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Reload</span>
            </button>
            <button
              type="button"
              onClick={togglePiP}
              title="Picture-in-Picture (P)"
              className="h-9 w-9 rounded-lg border border-[#252d3b] bg-[#181e28] text-[#cbd5e1] hover:text-white hover:border-[#394559] transition-colors grid place-items-center"
              aria-label="Picture in Picture"
            >
              <PictureInPicture2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setTheaterMode((t) => !t)}
              title="Theater Mode (T)"
              className={`h-9 px-2.5 rounded-lg border transition-colors hidden lg:inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${
                theaterMode
                  ? 'border-[#10b981] bg-[#10b981]/15 text-[#34d399]'
                  : 'border-[#252d3b] bg-[#181e28] text-[#cbd5e1] hover:text-white'
              }`}
            >
              <Tv className="w-3.5 h-3.5" />
              <span>Theater</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close Player (Esc)"
              aria-label="Close Player"
              className="h-9 w-9 rounded-lg border border-[#252d3b] bg-[#181e28] text-[#cbd5e1] hover:text-white hover:bg-[#ef4444]/20 hover:border-[#ef4444]/50 transition-colors grid place-items-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Player Body: Video Stage + Controls Side Panel */}
        <div
          className={`grid min-h-0 flex-1 ${
            theaterMode
              ? 'grid-cols-1 lg:grid-cols-[1fr_340px]'
              : 'grid-cols-1 lg:grid-cols-[1fr_320px]'
          }`}
        >
          {/* Video Stage */}
          <div
            ref={stageRef}
            onMouseMove={scheduleHideControls}
            onMouseLeave={() => {
              if (isPlaying) setControlsVisible(false);
            }}
            className="relative bg-black flex items-center justify-center aspect-video lg:aspect-auto lg:min-h-[460px] select-none overflow-hidden"
          >
            <video
              ref={videoRef}
              playsInline
              controlsList="nodownload noplaybackrate"
              onContextMenu={(e) => e.preventDefault()}
              onDragStart={(e) => e.preventDefault()}
              onClick={togglePlay}
              onDoubleClick={toggleFullscreen}
              onPlay={() => {
                setIsPlaying(true);
                setIsBuffering(false);
                confirmPlaybackWorking();
                scheduleHideControls();
              }}
              onPause={() => {
                setIsPlaying(false);
                setControlsVisible(true);
              }}
              onWaiting={() => setIsBuffering(true)}
              onCanPlay={() => {
                setIsBuffering(false);
                confirmPlaybackWorking();
              }}
              onError={() => {
                if (activeSource && advanceToNextPlayableServer(activeSource.tokenId)) return;
                setIsBuffering(false);
                setStreamError('Media playback error on this server. Try another server.');
              }}
              style={{
                filter: `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`,
              }}
              className={`w-full h-full ${videoFitClass}`}
            />

            {/* Top-left Sports Snap stage watermark */}
            <div
              className={`pointer-events-none absolute top-3 left-3 flex items-center gap-2.5 px-3 py-1.5 rounded-md bg-black/70 backdrop-blur-sm border border-white/15 transition-opacity duration-200 ${
                controlsVisible ? 'opacity-95' : 'opacity-60'
              }`}
            >
              <img
                src={BRAND_LOGO_URL}
                alt="Sports Snap"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                  const fb = e.currentTarget.nextElementSibling as HTMLElement | null;
                  if (fb) fb.style.display = 'inline';
                }}
                className="h-6 sm:h-7 w-auto object-contain"
              />
              <span
                style={{ display: 'none' }}
                className="font-display text-sm font-bold tracking-wider text-white uppercase"
              >
                Sports Snap
              </span>
              <span className="text-[11px] font-mono text-[#94a0b4] tabular-nums">
                {telemetry.resolution !== '—' ? telemetry.resolution : telemetry.protocol}
              </span>
            </div>

            {isFullscreen && (
              <div
                className={`pointer-events-none absolute left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-black/55 border border-white/10 transition-all duration-200 ${
                  controlsVisible || !isPlaying ? 'bottom-20' : 'bottom-3'
                }`}
              >
                <span className="font-display text-sm font-bold tracking-[0.2em] uppercase text-white/90">
                  Sports Snap
                </span>
              </div>
            )}

            {/* Buffering spinner */}
            {isBuffering && !streamError && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/50 px-4 text-center">
                <div className="w-10 h-10 rounded-full border-2 border-white/20 border-t-[#10b981] animate-spin" />
                <span className="mt-3 text-xs font-semibold text-white/95">
                  Connecting to Sports Snap feed…
                </span>
                <span className="mt-1 text-[11px] text-[#cbd5e1] max-w-xs">
                  Wait a few seconds to load, or change server if it doesn&apos;t play.
                </span>
              </div>
            )}

            {/* Stream Error Overlay */}
            {streamError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#090b0e]/92 p-6 text-center">
                <AlertTriangle className="w-9 h-9 text-[#f59e0b] mb-3" />
                <h3 className="text-base font-semibold text-white mb-1">
                  Stream Unavailable
                </h3>
                <p className="text-sm text-[#8e9aaf] max-w-md mb-4">
                  {streamError}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      autoDiscoverRef.current = false;
                      setReloadNonce((n) => n + 1);
                    }}
                    className="px-4 py-2 rounded-lg bg-[#10b981] hover:bg-[#059669] text-[#090b0e] text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Retry Server
                  </button>
                  {sources.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        autoDiscoverRef.current = false;
                        handleNextSource();
                      }}
                      className="px-4 py-2 rounded-lg border border-[#2d3646] bg-[#181e28] hover:bg-[#222a38] text-white text-xs font-semibold transition-colors cursor-pointer"
                    >
                      Try Next Server ({sources.length})
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Custom Transport & Advanced Controls Overlay */}
            <div
              className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/75 to-transparent pt-10 pb-3 px-3 sm:px-4 transition-opacity duration-200 ${
                controlsVisible || !isPlaying
                  ? 'opacity-100'
                  : 'opacity-0 pointer-events-none'
              }`}
            >
              {/* Seek / Buffer Bar */}
              <div className="group relative flex items-center h-4 mb-2 cursor-pointer">
                <div className="relative w-full h-1.5 rounded-full bg-white/20 overflow-hidden group-hover:h-2 transition-all">
                  <div
                    className="absolute inset-y-0 left-0 bg-white/30"
                    style={{ width: `${bufferedPct}%` }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 bg-[#10b981]"
                    style={{ width: `${isLiveStream && !behindLive ? 100 : progressPct}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  step={0.5}
                  value={isLiveStream && !behindLive ? duration || 100 : currentTime}
                  aria-label="Seek timeline"
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (videoRef.current && duration > 0) {
                      videoRef.current.currentTime = val;
                      setCurrentTime(val);
                    }
                  }}
                  className="absolute inset-0 w-full opacity-0 cursor-pointer"
                />
              </div>

              {/* Main Bottom Control Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Left Transport Controls */}
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <button
                    type="button"
                    onClick={togglePlay}
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                    className="h-9 w-9 rounded-lg bg-white/10 hover:bg-white/20 text-white grid place-items-center transition-colors"
                  >
                    {isPlaying ? (
                      <Pause className="w-4 h-4 fill-current" />
                    ) : (
                      <Play className="w-4 h-4 fill-current ml-0.5" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => seekBy(-10)}
                    title="Rewind 10s (J)"
                    aria-label="Rewind 10 seconds"
                    className="h-9 w-9 rounded-lg hover:bg-white/15 text-white/90 grid place-items-center transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => seekBy(10)}
                    title="Forward 10s (L)"
                    aria-label="Forward 10 seconds"
                    className="h-9 w-9 rounded-lg hover:bg-white/15 text-white/90 grid place-items-center transition-colors"
                  >
                    <RotateCw className="w-4 h-4" />
                  </button>

                  {/* Volume */}
                  <div className="flex items-center gap-1.5 ml-1">
                    <button
                      type="button"
                      onClick={toggleMute}
                      aria-label={isMuted ? 'Unmute' : 'Mute'}
                      className="h-9 w-9 rounded-lg hover:bg-white/15 text-white/90 grid place-items-center transition-colors"
                    >
                      {isMuted || volume === 0 ? (
                        <VolumeX className="w-4 h-4 text-[#f87171]" />
                      ) : (
                        <Volume2 className="w-4 h-4" />
                      )}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={isMuted ? 0 : volume}
                      aria-label="Volume"
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setVolume(v);
                        if (v > 0 && isMuted) setIsMuted(false);
                      }}
                      className="ss-range w-16 sm:w-20"
                    />
                  </div>

                  {/* Live Edge / Timecode */}
                  {isLiveStream ? (
                    <button
                      type="button"
                      onClick={jumpToLive}
                      title="Jump to Live Edge"
                      className={`ml-1 h-7 px-2.5 rounded text-[11px] font-mono font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                        behindLive
                          ? 'bg-white/15 text-white/80 hover:bg-[#ef4444] hover:text-white'
                          : 'bg-[#ef4444]/20 text-[#fca5a5] border border-[#ef4444]/40'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          behindLive ? 'bg-white/60' : 'bg-[#ef4444]'
                        }`}
                      />
                      {behindLive ? 'Go Live' : 'LIVE'}
                    </button>
                  ) : (
                    <span className="ml-1 text-xs font-mono text-white/80 tabular-nums whitespace-nowrap">
                      {formatPlayerTime(currentTime)} / {formatPlayerTime(duration)}
                    </span>
                  )}
                </div>

                {/* Right Utility Controls */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={captureSnap}
                    title="Snap Frame (S)"
                    aria-label="Capture frame snapshot"
                    className="h-8 px-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Snap</span>
                  </button>

                  {/* Speed Select */}
                  <select
                    aria-label="Playback speed"
                    value={playbackRate}
                    onChange={(e) => setPlaybackRate(Number(e.target.value))}
                    className="h-8 px-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-mono border border-white/10 outline-none cursor-pointer"
                  >
                    {SPEEDS.map((spd) => (
                      <option key={spd} value={spd} className="bg-[#10141b] text-white">
                        {spd}x
                      </option>
                    ))}
                  </select>

                  {/* Quality Select */}
                  <select
                    aria-label="Video quality"
                    value={selectedQuality}
                    onChange={(e) => handleQualityChange(Number(e.target.value))}
                    className="h-8 max-w-[118px] px-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-mono border border-white/10 outline-none cursor-pointer truncate"
                  >
                    {qualities.map((q) => (
                      <option
                        key={q.index}
                        value={q.index}
                        className="bg-[#10141b] text-white"
                      >
                        {q.label}
                      </option>
                    ))}
                  </select>

                  {/* Audio Track Select (when multiple exist) */}
                  {audioTracks.length > 1 && (
                    <select
                      aria-label="Audio track"
                      value={selectedAudio}
                      onChange={(e) => handleAudioChange(Number(e.target.value))}
                      className="h-8 max-w-[100px] px-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs border border-white/10 outline-none cursor-pointer truncate"
                    >
                      {audioTracks.map((a) => (
                        <option
                          key={a.index}
                          value={a.index}
                          className="bg-[#10141b] text-white"
                        >
                          {a.label}
                        </option>
                      ))}
                    </select>
                  )}

                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    title="Fullscreen (F)"
                    aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    className="h-8 w-8 rounded-lg bg-white/10 hover:bg-white/20 text-white grid place-items-center transition-colors"
                  >
                    {isFullscreen ? (
                      <Minimize2 className="w-4 h-4" />
                    ) : (
                      <Maximize2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Right/Bottom Advanced Controls & Channels Panel */}
          <aside className="bg-[#121720] border-t lg:border-t-0 lg:border-l border-[#232a36] flex flex-col min-h-0 max-h-[300px] lg:max-h-none">
            {/* Segmented Tab Switcher */}
            <div className="p-2.5 border-b border-[#232a36] bg-[#141922]">
              <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#0b0e13] border border-[#1f2633]">
                <button
                  type="button"
                  onClick={() => setActiveTab('sources')}
                  className={`py-1.5 px-3 rounded-md text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                    activeTab === 'sources'
                      ? 'bg-[#1f2633] text-white'
                      : 'text-[#8e9aaf] hover:text-white'
                  }`}
                >
                  <Radio className="w-3.5 h-3.5" />
                  <span>Servers ({sources.length})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('controls')}
                  className={`py-1.5 px-3 rounded-md text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                    activeTab === 'controls'
                      ? 'bg-[#1f2633] text-white'
                      : 'text-[#8e9aaf] hover:text-white'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>Controls Panel</span>
                </button>
              </div>
            </div>

            {/* Panel Body */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
              {activeTab === 'sources' ? (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs text-[#8e9aaf]">
                    <span>Available Broadcast Servers</span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#10b981]">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>Protected</span>
                    </span>
                  </div>

                  <p
                    data-server-hint
                    className="text-[11px] leading-relaxed text-[#94a0b4] bg-[#0d1118] border border-[#1f2633] rounded-lg px-3 py-2"
                  >
                    Please wait a few seconds for the stream to load. Change server below if it does not play.
                  </p>

                  {sources.map((src, idx) => {
                    const active = idx === activeIndex;
                    const proto = detectProtocol(src);
                    const hasDrm = Boolean(src.hasDrm);
                    return (
                      <button
                        key={`${src.tokenId}-${idx}`}
                        type="button"
                        onClick={() => {
                          autoDiscoverRef.current = false;
                          setActiveIndex(idx);
                        }}
                        className={`w-full text-left px-3.5 py-2.5 rounded-lg border transition-colors flex items-center justify-between gap-2 ${
                          active
                            ? 'bg-[#10b981]/12 border-[#10b981]/60 text-white'
                            : 'bg-[#171d28] border-[#242b38] text-[#cbd5e1] hover:border-[#364154]'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">
                            {src.channel_name || `Feed ${idx + 1}`}
                          </div>
                          <div className="text-[11px] font-mono text-[#8e9aaf] mt-0.5">
                            {proto}
                            {hasDrm ? ' · ClearKey DRM' : ''}
                          </div>
                        </div>
                        {active && (
                          <span className="text-[11px] font-mono font-semibold text-[#34d399] shrink-0">
                            Active
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-5">
                  {/* Video Aspect & Fit */}
                  <div>
                    <div className="text-xs font-semibold text-[#cbd5e1] mb-2">
                      Aspect Ratio & Frame Fit
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {(['contain', 'cover', '16:9', '4:3'] as AspectFitMode[]).map(
                        (mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setAspectMode(mode)}
                            className={`py-1.5 rounded-md text-xs font-mono border transition-colors ${
                              aspectMode === mode
                                ? 'bg-[#10b981]/15 border-[#10b981]/60 text-[#34d399]'
                                : 'bg-[#171d28] border-[#242b38] text-[#94a0b4] hover:text-white'
                            }`}
                          >
                            {mode === 'contain'
                              ? 'Fit'
                              : mode === 'cover'
                                ? 'Fill'
                                : mode}
                          </button>
                        )
                      )}
                    </div>
                  </div>

                  {/* Picture Calibration */}
                  <div className="space-y-3 pt-2 border-t border-[#202733]">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#cbd5e1]">
                        Picture Calibration
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setBrightness(100);
                          setContrast(100);
                          setSaturation(100);
                        }}
                        className="text-[11px] text-[#10b981] hover:underline"
                      >
                        Reset
                      </button>
                    </div>

                    <label className="block space-y-1">
                      <div className="flex justify-between text-[11px] text-[#8e9aaf]">
                        <span>Brightness</span>
                        <span className="font-mono tabular-nums">{brightness}%</span>
                      </div>
                      <input
                        type="range"
                        min={50}
                        max={150}
                        value={brightness}
                        onChange={(e) => setBrightness(Number(e.target.value))}
                        className="ss-range w-full"
                      />
                    </label>

                    <label className="block space-y-1">
                      <div className="flex justify-between text-[11px] text-[#8e9aaf]">
                        <span>Contrast</span>
                        <span className="font-mono tabular-nums">{contrast}%</span>
                      </div>
                      <input
                        type="range"
                        min={50}
                        max={150}
                        value={contrast}
                        onChange={(e) => setContrast(Number(e.target.value))}
                        className="ss-range w-full"
                      />
                    </label>

                    <label className="block space-y-1">
                      <div className="flex justify-between text-[11px] text-[#8e9aaf]">
                        <span>Saturation</span>
                        <span className="font-mono tabular-nums">{saturation}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={200}
                        value={saturation}
                        onChange={(e) => setSaturation(Number(e.target.value))}
                        className="ss-range w-full"
                      />
                    </label>
                  </div>

                  {/* Engine Toggles */}
                  <div className="space-y-2.5 pt-2 border-t border-[#202733]">
                    <div className="text-xs font-semibold text-[#cbd5e1]">
                      Stream Engine
                    </div>
                    <label className="flex items-center justify-between text-xs text-[#94a0b4] cursor-pointer">
                      <span>Low-Latency Buffering</span>
                      <input
                        type="checkbox"
                        checked={lowLatency}
                        onChange={(e) => setLowLatency(e.target.checked)}
                        className="accent-[#10b981] w-4 h-4 rounded"
                      />
                    </label>
                    <label className="flex items-center justify-between text-xs text-[#94a0b4] cursor-pointer">
                      <span>Auto-Recover Stream Stalls</span>
                      <input
                        type="checkbox"
                        checked={autoRecover}
                        onChange={(e) => setAutoRecover(e.target.checked)}
                        className="accent-[#10b981] w-4 h-4 rounded"
                      />
                    </label>
                  </div>

                  {/* Real Stream Inspector */}
                  <div className="space-y-1.5 pt-2 border-t border-[#202733]">
                    <div className="text-xs font-semibold text-[#cbd5e1] mb-1">
                      Stream Telemetry
                    </div>
                    <div className="grid grid-cols-2 gap-y-1.5 text-xs">
                      <span className="text-[#8e9aaf]">State</span>
                      <span className="text-right font-mono text-white">
                        {telemetry.playbackState}
                      </span>
                      <span className="text-[#8e9aaf]">Resolution</span>
                      <span className="text-right font-mono tabular-nums text-white">
                        {telemetry.resolution}
                      </span>
                      <span className="text-[#8e9aaf]">Bitrate</span>
                      <span className="text-right font-mono tabular-nums text-white">
                        {telemetry.bitrateMbps}
                      </span>
                      <span className="text-[#8e9aaf]">Buffer Ahead</span>
                      <span className="text-right font-mono tabular-nums text-white">
                        {telemetry.bufferSeconds}s
                      </span>
                      <span className="text-[#8e9aaf]">Dropped Frames</span>
                      <span className="text-right font-mono tabular-nums text-white">
                        {telemetry.droppedFrames}
                      </span>
                    </div>
                  </div>

                  {/* Keyboard Shortcuts */}
                  <div className="space-y-1.5 pt-2 border-t border-[#202733]">
                    <div className="text-xs font-semibold text-[#cbd5e1]">
                      Keyboard Shortcuts
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-[11px] text-[#8e9aaf]">
                      <div>
                        <kbd className="font-mono text-white">Space</kbd> Play / Pause
                      </div>
                      <div>
                        <kbd className="font-mono text-white">M</kbd> Mute
                      </div>
                      <div>
                        <kbd className="font-mono text-white">F</kbd> Fullscreen
                      </div>
                      <div>
                        <kbd className="font-mono text-white">P</kbd> Picture-in-Pic
                      </div>
                      <div>
                        <kbd className="font-mono text-white">S</kbd> Snap Frame
                      </div>
                      <div>
                        <kbd className="font-mono text-white">← / →</kbd> Seek 10s
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>

        {/* Bottom-Center Sports Snap Player Brand Footer */}
        <div className="px-4 py-1.5 bg-[#0b0e13] border-t border-[#1e2532] flex items-center justify-center shrink-0">
          <span
            data-player-bottom-brand
            className="font-display text-sm sm:text-base font-bold tracking-[0.22em] uppercase text-white/90"
          >
            Sports Snap
          </span>
        </div>
      </div>
    </div>
  );
};
