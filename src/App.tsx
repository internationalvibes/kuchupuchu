import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutGrid,
  List,
  Play,
  RefreshCw,
  Search,
  Share2,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  MatchItem,
  SortOption,
  SportTab,
  StatusFilter,
  ViewMode,
} from './types';
import {
  BRAND_LOGO_URL,
  categoryPriorityRank,
  eventName,
  getMatchSlug,
  isCricket,
  isFootball,
  isLive,
  matchStatus,
  shareMatch,
  sportTabOf,
  streamsOf,
  teamA,
  teamB,
  timeText,
  validStreams,
} from './utils/sports';
import { fetchProtectedFeed } from './utils/streamVault';
import { installStrictPrivacyShield } from './utils/privacyShield';
import { installClickTouchRedirectAd } from './utils/adRedirect';
import { TeamLogo } from './components/TeamLogo';
import { SportsSnapPlayer } from './components/SportsSnapPlayer';

const STATUS_NAV: { key: StatusFilter; label: string }[] = [
  { key: 'ALL', label: 'All Matches' },
  { key: 'LIVE', label: 'Live Now' },
  { key: 'UPCOMING', label: 'Upcoming' },
  { key: 'ENDED', label: 'Finished' },
];

const SPORT_TABS: { key: SportTab; label: string }[] = [
  { key: 'CRICKET', label: 'Cricket' },
  { key: 'FOOTBALL', label: 'Football' },
  { key: 'OTHERS', label: 'Others' },
];

export default function App() {
  const [matches, setMatches] = useState<MatchItem[]>([]);
  const [totalCountMeta, setTotalCountMeta] = useState<number | null>(null);
  const [liveCountMeta, setLiveCountMeta] = useState<number | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [sportTab, setSportTab] = useState<SportTab | 'ALL'>('CRICKET');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortOption, setSortOption] = useState<SortOption>('default');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  const [activeMatch, setActiveMatch] = useState<MatchItem | null>(null);
  const [privacyLocked, setPrivacyLocked] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const handledShareSlugRef = useRef<boolean>(false);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 2800);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const feed = await fetchProtectedFeed();
      setMatches(feed.matches);
      setTotalCountMeta(feed.totalMatches);
      setLiveCountMeta(feed.liveMatch);
      setLastUpdated(feed.lastUpdateTime);

      if (!handledShareSlugRef.current) {
        handledShareSlugRef.current = true;
        const sharedSlug = new URLSearchParams(window.location.search).get('match');
        if (sharedSlug) {
          const found = feed.matches.find((m) => getMatchSlug(m) === sharedSlug);
          if (found) {
            setSportTab(sportTabOf(found));
            if (isLive(found) && validStreams(found).length > 0) {
              setActiveMatch(found);
            } else {
              showToast(
                `${found.event_name || eventName(found)} · ${timeText(found)}`
              );
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load sports feed');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Strict privacy shield: blocks right-click, copy/select, inspect shortcuts, and DevTools
  useEffect(() => {
    return installStrictPrivacyShield(showToast, (isOpen) => {
      setPrivacyLocked(isOpen);
      if (isOpen) {
        setActiveMatch(null);
      }
    });
  }, [showToast]);

  // Click-triggered & touch-triggered redirect ads with 20s cooldown gap
  useEffect(() => {
    return installClickTouchRedirectAd();
  }, []);

  // '/' shortcut focuses search when player is closed
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeMatch) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeMatch]);

  // Summary counts
  const summary = useMemo(() => {
    const liveMatches = matches.filter(isLive).length;
    const upcomingMatches = matches.filter(
      (m) => matchStatus(m) === 'UPCOMING'
    ).length;
    const totalChannels = matches.reduce(
      (acc, m) => acc + validStreams(m).length,
      0
    );
    return {
      total: totalCountMeta ?? matches.length,
      live: liveCountMeta ?? liveMatches,
      upcoming: upcomingMatches,
      channels: totalChannels,
    };
  }, [matches, totalCountMeta, liveCountMeta]);

  // Sport category directory sorted by priority: Cricket -> Football -> Others alphabetically
  const categories = useMemo(() => {
    const map = new Map<string, { total: number; live: number }>();
    for (const m of matches) {
      const cat = m.Category || 'Other';
      const entry = map.get(cat) || { total: 0, live: 0 };
      entry.total += 1;
      if (isLive(m)) entry.live += 1;
      map.set(cat, entry);
    }
    return Array.from(map.entries())
      .map(([name, counts]) => ({ name, ...counts }))
      .sort((a, b) => {
        const rankDiff = categoryPriorityRank(a.name) - categoryPriorityRank(b.name);
        if (rankDiff !== 0) return rankDiff;
        return a.name.localeCompare(b.name);
      });
  }, [matches]);

  // Base list matching status + search (used to compute live/total counts on Cricket / Football / Others tabs)
  const baseMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return matches.filter((m) => {
      const statusOk =
        statusFilter === 'ALL' || matchStatus(m) === statusFilter;
      if (!statusOk) return false;
      if (!q) return true;
      const haystack = [
        m.event_name,
        eventName(m),
        teamA(m),
        teamB(m),
        m.Category,
        ...streamsOf(m).map((s) => s.channel_name),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [matches, statusFilter, searchQuery]);

  const tabStats = useMemo(() => {
    const stats: Record<SportTab, { total: number; live: number }> = {
      CRICKET: { total: 0, live: 0 },
      FOOTBALL: { total: 0, live: 0 },
      OTHERS: { total: 0, live: 0 },
    };
    for (const m of baseMatches) {
      const tab = sportTabOf(m);
      stats[tab].total += 1;
      if (isLive(m)) stats[tab].live += 1;
    }
    return stats;
  }, [baseMatches]);

  // Filtered + priority-sorted matches
  const filteredMatches = useMemo(() => {
    const list = baseMatches.filter((m) => {
      const tabOk = sportTab === 'ALL' || sportTabOf(m) === sportTab;
      const catOk =
        categoryFilter === 'ALL' || (m.Category || 'Other') === categoryFilter;
      return tabOk && catOk;
    });

    const sorted = [...list];
    if (sortOption === 'live') {
      sorted.sort((a, b) => {
        const liveDiff = Number(isLive(b)) - Number(isLive(a));
        if (liveDiff !== 0) return liveDiff;
        return categoryPriorityRank(a.Category) - categoryPriorityRank(b.Category);
      });
    } else if (sortOption === 'name') {
      sorted.sort((a, b) =>
        String(a.event_name || '').localeCompare(String(b.event_name || ''))
      );
    } else {
      sorted.sort(
        (a, b) =>
          categoryPriorityRank(a.Category) - categoryPriorityRank(b.Category)
      );
    }
    return sorted;
  }, [baseMatches, sportTab, categoryFilter, sortOption]);

  // Featured live stream for top bar CTA (1st Cricket, 2nd Football, then Others)
  const featuredLiveMatch = useMemo(() => {
    const playableLive = matches.filter(
      (m) => isLive(m) && validStreams(m).length > 0
    );
    if (!playableLive.length) return null;
    return (
      playableLive.find((m) => isCricket(m)) ||
      playableLive.find((m) => isFootball(m)) ||
      playableLive[0]
    );
  }, [matches]);

  const handleOpenMatch = useCallback(
    (m: MatchItem) => {
      if (!isLive(m)) {
        const st = matchStatus(m);
        showToast(
          st === 'UPCOMING'
            ? `Scheduled · ${timeText(m)}`
            : 'This broadcast has ended'
        );
        return;
      }
      const streams = validStreams(m);
      if (!streams.length) {
        showToast('No playable feeds available for this match yet');
        return;
      }
      setActiveMatch(m);
    },
    [showToast]
  );

  const handleShareMatch = useCallback(
    (m: MatchItem) => {
      shareMatch(m, showToast);
    },
    [showToast]
  );

  const handleSelectSportTab = (tab: SportTab) => {
    setSportTab(tab);
    setCategoryFilter('ALL');
  };

  const handleSelectDirectoryCategory = (catName: string) => {
    if (catName === 'ALL') {
      setSportTab('ALL');
      setCategoryFilter('ALL');
      return;
    }
    const lower = catName.toLowerCase();
    if (lower === 'cricket') {
      setSportTab('CRICKET');
      setCategoryFilter('ALL');
    } else if (lower === 'football') {
      setSportTab('FOOTBALL');
      setCategoryFilter('ALL');
    } else {
      setSportTab('OTHERS');
      setCategoryFilter(catName);
    }
  };

  const resetFilters = () => {
    setStatusFilter('ALL');
    setSportTab('CRICKET');
    setCategoryFilter('ALL');
    setSearchQuery('');
    setSortOption('default');
  };

  const hasActiveFilters =
    statusFilter !== 'ALL' ||
    categoryFilter !== 'ALL' ||
    searchQuery.trim() !== '' ||
    sortOption !== 'default';

  const cricketRows = useMemo(
    () => filteredMatches.filter(isCricket),
    [filteredMatches]
  );
  const footballRows = useMemo(
    () => filteredMatches.filter(isFootball),
    [filteredMatches]
  );
  const otherRows = useMemo(
    () => filteredMatches.filter((m) => !isCricket(m) && !isFootball(m)),
    [filteredMatches]
  );

  const activeTabLabel =
    sportTab === 'CRICKET'
      ? 'Cricket'
      : sportTab === 'FOOTBALL'
        ? 'Football'
        : sportTab === 'OTHERS'
          ? categoryFilter !== 'ALL'
            ? categoryFilter
            : 'Other Sports'
          : 'All Sports';

  return (
    <div className="min-h-screen flex flex-col bg-[#090b0e] text-[#f3f5f8]">
      {/* Top Bar Contract: Zone 1 Brand — Zone 2 4 Nav Links — Zone 3 1 Primary CTA */}
      <header className="sticky top-0 z-30 bg-[#090b0e]/95 backdrop-blur-md border-b border-[#202733]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Brand Logo */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              resetFilters();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#10b981] rounded"
            aria-label="Sports Snap Home"
          >
            <img
              src={BRAND_LOGO_URL}
              alt="Sports Snap"
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                const fb = e.currentTarget.nextElementSibling as HTMLElement | null;
                if (fb) fb.style.display = 'inline-flex';
              }}
              className="h-8 sm:h-9 w-auto object-contain"
            />
            <span
              style={{ display: 'none' }}
              className="items-center gap-2.5"
            >
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#10b981] text-[#090b0e]">
                <svg
                  viewBox="0 0 24 24"
                  className="w-4 h-4 fill-current"
                  aria-hidden="true"
                >
                  <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
                </svg>
              </span>
              <span className="font-display text-2xl font-bold tracking-tight text-white">
                Sports Snap
              </span>
            </span>
          </a>

          {/* Zone 2: 4 Single-line Navigation Links */}
          <nav
            className="hidden md:flex items-center gap-7"
            aria-label="Primary status navigation"
          >
            {STATUS_NAV.map((item) => {
              const active = statusFilter === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setStatusFilter(item.key)}
                  className={`relative py-5 text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    active
                      ? 'text-white'
                      : 'text-[#8e9aaf] hover:text-[#e2e8f0]'
                  }`}
                >
                  {item.label}
                  {active && (
                    <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[#10b981]" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="shrink-0">
            {featuredLiveMatch ? (
              <button
                type="button"
                onClick={() => handleOpenMatch(featuredLiveMatch)}
                className="px-4 py-2 rounded-lg bg-[#10b981] hover:bg-[#059669] text-[#090b0e] text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Watch Live</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={loadData}
                className="px-4 py-2 rounded-lg border border-[#2a3342] bg-[#161b24] hover:bg-[#1e2531] text-white text-sm font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
                />
                <span>Refresh Feeds</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Mobile Compact Status Filter Strip (visible below md) */}
      <div className="md:hidden border-b border-[#202733] bg-[#0e1218] px-4 py-2 flex items-center gap-2 overflow-x-auto">
        {STATUS_NAV.map((item) => {
          const active = statusFilter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setStatusFilter(item.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                active
                  ? 'bg-[#10b981] text-[#090b0e]'
                  : 'bg-[#161b24] text-[#94a0b4]'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Main Workspace: Sidebar Rail + Content Viewport */}
      <div className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6 grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-8">
        {/* Left Navigation & Filter Rail */}
        <aside className="space-y-6">
          {/* Search Input */}
          <div>
            <label htmlFor="match-search" className="sr-only">
              Search teams, leagues, or channels
            </label>
            <div className="relative">
              <Search className="w-4 h-4 text-[#64748b] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchInputRef}
                id="match-search"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search teams, leagues… ( / )"
                className="w-full h-11 pl-10 pr-9 rounded-lg bg-[#12161e] border border-[#242b38] text-sm text-white placeholder-[#64748b] focus:outline-none focus:border-[#10b981] transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8e9aaf] hover:text-white p-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Sports Directory */}
          <div>
            <div className="text-xs font-semibold text-[#8e9aaf] mb-2.5 px-1">
              Sports Directory
            </div>
            <div className="flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0">
              <button
                type="button"
                onClick={() => handleSelectDirectoryCategory('ALL')}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  sportTab === 'ALL' && categoryFilter === 'ALL'
                    ? 'bg-[#1a212d] text-white border border-[#2e384b]'
                    : 'text-[#94a0b4] hover:text-white hover:bg-[#131822] border border-transparent'
                }`}
              >
                <span>All Sports</span>
                <span className="font-mono text-xs tabular-nums text-[#8e9aaf]">
                  {matches.length}
                </span>
              </button>

              {categories.map((cat) => {
                const lower = cat.name.toLowerCase();
                const active =
                  (lower === 'cricket' && sportTab === 'CRICKET') ||
                  (lower === 'football' && sportTab === 'FOOTBALL') ||
                  (lower !== 'cricket' &&
                    lower !== 'football' &&
                    categoryFilter === cat.name);
                return (
                  <button
                    key={cat.name}
                    type="button"
                    onClick={() => handleSelectDirectoryCategory(cat.name)}
                    className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#1a212d] text-white border border-[#2e384b]'
                        : 'text-[#94a0b4] hover:text-white hover:bg-[#131822] border border-transparent'
                    }`}
                  >
                    <span className="truncate">{cat.name}</span>
                    <span className="flex items-center gap-2 font-mono text-xs tabular-nums shrink-0">
                      {cat.live > 0 && (
                        <span className="text-[#f87171]">{cat.live} live</span>
                      )}
                      <span className="text-[#64748b]">{cat.total}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Sort & View Controls */}
          <div className="pt-4 border-t border-[#1e2430] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="sort-select"
                className="text-xs font-semibold text-[#8e9aaf]"
              >
                Sort Order
              </label>
              <div className="inline-flex rounded-lg bg-[#12161e] border border-[#242b38] p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  aria-label="Grid view"
                  title="Grid view"
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-[#202735] text-white'
                      : 'text-[#64748b] hover:text-white'
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  aria-label="Compact list view"
                  title="Compact list view"
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === 'list'
                      ? 'bg-[#202735] text-white'
                      : 'text-[#64748b] hover:text-white'
                  }`}
                >
                  <List className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <select
              id="sort-select"
              value={sortOption}
              onChange={(e) => setSortOption(e.target.value as SortOption)}
              className="w-full h-10 px-3 rounded-lg bg-[#12161e] border border-[#242b38] text-sm text-white focus:outline-none focus:border-[#10b981] cursor-pointer"
            >
              <option value="default">Recommended order</option>
              <option value="live">Live matches first</option>
              <option value="name">Alphabetical (A–Z)</option>
            </select>
          </div>

          {/* Unboxed Tabular Summary */}
          <div className="pt-4 border-t border-[#1e2430] space-y-2.5">
            <div className="flex items-center justify-between text-xs font-semibold text-[#8e9aaf]">
              <span>Feed Summary</span>
              <button
                type="button"
                onClick={loadData}
                className="text-[#10b981] hover:underline font-medium cursor-pointer"
              >
                Sync
              </button>
            </div>
            <dl className="divide-y divide-[#1a202c] text-xs">
              <div className="py-2 flex justify-between">
                <dt className="text-[#8e9aaf]">Total Fixtures</dt>
                <dd className="font-mono tabular-nums text-white font-semibold">
                  {loading ? '—' : summary.total}
                </dd>
              </div>
              <div className="py-2 flex justify-between">
                <dt className="text-[#8e9aaf]">Live Broadcasts</dt>
                <dd className="font-mono tabular-nums text-[#f87171] font-semibold">
                  {loading ? '—' : summary.live}
                </dd>
              </div>
              <div className="py-2 flex justify-between">
                <dt className="text-[#8e9aaf]">Upcoming</dt>
                <dd className="font-mono tabular-nums text-white font-semibold">
                  {loading ? '—' : summary.upcoming}
                </dd>
              </div>
              <div className="py-2 flex justify-between">
                <dt className="text-[#8e9aaf]">Playable Channels</dt>
                <dd className="font-mono tabular-nums text-[#10b981] font-semibold">
                  {loading ? '—' : summary.channels}
                </dd>
              </div>
            </dl>
            {lastUpdated && (
              <p className="text-[11px] text-[#64748b] pt-1">
                Updated {lastUpdated}
              </p>
            )}
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="min-w-0 space-y-6">
          {/* Primary Priority Tabs: Cricket (1st), Football (2nd), Others (3rd) */}
          <div
            role="tablist"
            aria-label="Sport category tabs"
            className="grid grid-cols-3 gap-2 p-1.5 rounded-xl bg-[#10141b] border border-[#222936]"
          >
            {SPORT_TABS.map((tab) => {
              const active = sportTab === tab.key;
              const stats = tabStats[tab.key];
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => handleSelectSportTab(tab.key)}
                  className={`flex items-center justify-between gap-2 px-3.5 sm:px-5 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-[#10b981] text-[#090b0e] shadow-sm'
                      : 'text-[#94a0b4] hover:text-white hover:bg-[#161c27]'
                  }`}
                >
                  <span className="font-display text-base sm:text-lg font-bold tracking-tight">
                    {tab.label}
                  </span>
                  <span
                    className={`flex items-center gap-2 font-mono text-xs tabular-nums ${
                      active ? 'text-[#090b0e]/85' : 'text-[#64748b]'
                    }`}
                  >
                    {stats.live > 0 && (
                      <span
                        className={`inline-flex items-center gap-1 font-semibold ${
                          active ? 'text-[#090b0e]' : 'text-[#f87171]'
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            active ? 'bg-[#090b0e]' : 'bg-[#ef4444]'
                          }`}
                        />
                        {stats.live}
                      </span>
                    )}
                    <span>{loading ? '—' : stats.total}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Section Header */}
          <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-[#1e2430] pb-3">
            <div>
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
                {statusFilter === 'LIVE'
                  ? 'Live Broadcasts'
                  : statusFilter === 'UPCOMING'
                    ? 'Upcoming Fixtures'
                    : statusFilter === 'ENDED'
                      ? 'Finished Events'
                      : 'All Fixtures'}
                {` · ${activeTabLabel}`}
              </h2>
              <p className="text-sm text-[#8e9aaf] mt-0.5">
                Select any live fixture to open the Sports Snap player and controls panel.
              </p>
            </div>

            <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-[#8e9aaf]">
              <span>
                {filteredMatches.length} fixture
                {filteredMatches.length === 1 ? '' : 's'}
              </span>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="text-[#10b981] hover:underline font-sans font-medium cursor-pointer"
                >
                  Reset filters
                </button>
              )}
            </div>
          </div>

          {/* Loading Skeletons */}
          {loading && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div
                  key={idx}
                  className="h-52 rounded-xl border border-[#1f2633] bg-[#11151d] animate-pulse p-5 flex flex-col justify-between"
                >
                  <div className="h-3 w-32 bg-[#1c2330] rounded" />
                  <div className="flex items-center justify-between gap-4">
                    <div className="w-11 h-11 rounded-full bg-[#1c2330]" />
                    <div className="w-8 h-3 bg-[#1c2330] rounded" />
                    <div className="w-11 h-11 rounded-full bg-[#1c2330]" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-4 w-3/4 bg-[#1c2330] rounded" />
                    <div className="h-3 w-1/2 bg-[#1c2330] rounded" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Error State */}
          {!loading && error && (
            <div className="rounded-xl border border-[#2a3241] bg-[#11151d] p-10 text-center space-y-3">
              <h3 className="font-display text-xl font-bold text-white">
                Unable to reach sports data feed
              </h3>
              <p className="text-sm text-[#8e9aaf] max-w-md mx-auto">{error}</p>
              <button
                type="button"
                onClick={loadData}
                className="mt-2 px-5 py-2.5 rounded-lg bg-[#10b981] hover:bg-[#059669] text-[#090b0e] text-sm font-semibold transition-colors cursor-pointer"
              >
                Try Again
              </button>
            </div>
          )}

          {/* Empty State */}
          {!loading && !error && filteredMatches.length === 0 && (
            <div className="rounded-xl border border-dashed border-[#273040] bg-[#0e1218] p-12 text-center space-y-3">
              <h3 className="font-display text-xl font-bold text-white">
                No matching fixtures
              </h3>
              <p className="text-sm text-[#8e9aaf] max-w-md mx-auto">
                Adjust your search keywords, sport category, or status filter to see available matches.
              </p>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="mt-2 px-4 py-2 rounded-lg border border-[#2c3545] bg-[#161b24] hover:bg-[#1e2531] text-white text-sm font-medium transition-colors cursor-pointer"
                >
                  Clear All Filters
                </button>
              )}
            </div>
          )}

          {/* Match Sections (Priority: Cricket -> Football -> Other Sports) */}
          {!loading && !error && filteredMatches.length > 0 && (
            <div className="space-y-8">
              {sportTab === 'ALL' ? (
                <>
                  {cricketRows.length > 0 && (
                    <MatchGroup
                      title="Cricket"
                      count={cricketRows.length}
                      matches={cricketRows}
                      viewMode={viewMode}
                      onSelect={handleOpenMatch}
                      onShare={handleShareMatch}
                    />
                  )}
                  {footballRows.length > 0 && (
                    <MatchGroup
                      title="Football"
                      count={footballRows.length}
                      matches={footballRows}
                      viewMode={viewMode}
                      onSelect={handleOpenMatch}
                      onShare={handleShareMatch}
                    />
                  )}
                  {otherRows.length > 0 && (
                    <MatchGroup
                      title="Other Sports"
                      count={otherRows.length}
                      matches={otherRows}
                      viewMode={viewMode}
                      onSelect={handleOpenMatch}
                      onShare={handleShareMatch}
                    />
                  )}
                </>
              ) : (
                <MatchGroup
                  title={activeTabLabel}
                  count={filteredMatches.length}
                  matches={filteredMatches}
                  viewMode={viewMode}
                  onSelect={handleOpenMatch}
                  onShare={handleShareMatch}
                  hideHeader
                />
              )}
            </div>
          )}
        </main>
      </div>

      {/* Minimalist Footer */}
      <footer className="border-t border-[#1c222d] mt-12">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[#64748b]">
          <div className="flex items-center gap-2.5">
            <img
              src={BRAND_LOGO_URL}
              alt="Sports Snap"
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                const fb = e.currentTarget.nextElementSibling as HTMLElement | null;
                if (fb) fb.style.display = 'inline';
              }}
              className="h-6 w-auto object-contain opacity-90"
            />
            <span style={{ display: 'none' }} className="font-semibold text-[#94a0b4]">
              Sports Snap
            </span>
          </div>
          <span>Live & Upcoming Global Sports Directory</span>
        </div>
      </footer>

      {/* Advanced Sports Snap Player Modal */}
      {!privacyLocked && (
        <SportsSnapPlayer
          match={activeMatch}
          onClose={() => setActiveMatch(null)}
          onNotify={showToast}
        />
      )}

      {/* Privacy Lockout Overlay when Developer Tools open */}
      {privacyLocked && (
        <div
          role="alertdialog"
          aria-modal="true"
          className="fixed inset-0 z-[100] bg-[#090b0e]/98 backdrop-blur-lg flex items-center justify-center p-6 text-center"
        >
          <div className="max-w-md rounded-xl border border-[#2a3342] bg-[#10141b] p-8 space-y-4 shadow-2xl">
            <ShieldAlert className="w-11 h-11 text-[#10b981] mx-auto" />
            <h2 className="font-display text-2xl font-bold text-white tracking-tight">
              Protected Stream Notice
            </h2>
            <p className="text-sm text-[#8e9aaf] leading-relaxed">
              Developer tools and source inspection are restricted on Sports Snap.
              Close developer tools to resume watching live fixtures.
            </p>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] px-4 py-2.5 rounded-lg bg-[#181e28] border border-[#2d3646] text-sm font-medium text-white shadow-xl"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}

interface MatchGroupProps {
  title: string;
  count: number;
  matches: MatchItem[];
  viewMode: ViewMode;
  onSelect: (m: MatchItem) => void;
  onShare: (m: MatchItem) => void;
  hideHeader?: boolean;
}

const MatchGroup: React.FC<MatchGroupProps> = ({
  title,
  count,
  matches,
  viewMode,
  onSelect,
  onShare,
  hideHeader = false,
}) => {
  return (
    <section className="space-y-4">
      {!hideHeader && (
        <div className="flex items-center gap-3">
          <h3 className="font-display text-xl font-bold text-white tracking-tight">
            {title}
          </h3>
          <span className="text-xs font-mono tabular-nums text-[#64748b]">
            {count}
          </span>
          <div className="h-px flex-1 bg-[#1e2430]" />
        </div>
      )}

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {matches.map((m, idx) => (
            <MatchCard
              key={`${m.event_name || 'match'}-${idx}`}
              match={m}
              onSelect={onSelect}
              onShare={onShare}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-[#222936] bg-[#11151d] divide-y divide-[#1c222d] overflow-hidden">
          {matches.map((m, idx) => (
            <MatchListRow
              key={`${m.event_name || 'row'}-${idx}`}
              match={m}
              onSelect={onSelect}
              onShare={onShare}
            />
          ))}
        </div>
      )}
    </section>
  );
};

const MatchCard: React.FC<{
  match: MatchItem;
  onSelect: (m: MatchItem) => void;
  onShare: (m: MatchItem) => void;
}> = ({ match, onSelect, onShare }) => {
  const status = matchStatus(match);
  const live = status === 'LIVE';
  const streams = live ? validStreams(match) : [];
  const playable = live && streams.length > 0;
  const info = match.eventInfo || {};
  const a = teamA(match);
  const b = teamB(match);

  return (
    <article
      onClick={() => onSelect(match)}
      className={`group rounded-xl border border-[#222936] bg-[#11151d] p-5 flex flex-col justify-between gap-4 transition-all duration-150 ${
        playable
          ? 'cursor-pointer hover:border-[#364257] hover:bg-[#151a24] hover:-translate-y-0.5'
          : 'opacity-80 cursor-default'
      }`}
    >
      {/* Top 1-line unboxed metadata kicker (Zero-Pill Rule) */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0 text-[#8e9aaf]">
          {live ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-[#f87171] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444]" />
              LIVE
            </span>
          ) : (
            <span className="font-medium text-[#94a0b4] shrink-0">
              {status === 'UPCOMING' ? 'Upcoming' : 'Ended'}
            </span>
          )}
          <span aria-hidden="true">·</span>
          <span className="truncate">{match.Category || 'Sports'}</span>
        </div>
        <span className="font-mono tabular-nums text-[11px] text-[#64748b] shrink-0">
          {timeText(match)}
        </span>
      </div>

      {/* Matchup Crest Row */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 py-1">
        <div className="flex flex-col items-center gap-2 min-w-0">
          <TeamLogo
            primary={info.teamAFlag}
            fallback={info.event_logo}
            teamName={a}
            size="md"
          />
          <span
            title={a}
            className="text-xs font-semibold text-[#e2e8f0] text-center truncate w-full"
          >
            {a}
          </span>
        </div>

        <span className="font-mono text-[11px] font-semibold text-[#64748b] px-1">
          VS
        </span>

        <div className="flex flex-col items-center gap-2 min-w-0">
          <TeamLogo
            primary={info.teamBFlag}
            fallback={info.event_logo}
            teamName={b || a}
            size="md"
          />
          <span
            title={b || eventName(match)}
            className="text-xs font-semibold text-[#e2e8f0] text-center truncate w-full"
          >
            {b || '—'}
          </span>
        </div>
      </div>

      {/* Event Title & Action Footer */}
      <div className="pt-3 border-t border-[#1b212c] flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-white truncate">
            {match.event_name || eventName(match)}
          </h4>
          <p className="text-xs text-[#8e9aaf] truncate mt-0.5">
            {eventName(match)}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {playable ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#10b981] group-hover:text-[#34d399] whitespace-nowrap">
              <Play className="w-3 h-3 fill-current" />
              <span>
                {streams.length} server{streams.length === 1 ? '' : 's'}
              </span>
            </span>
          ) : (
            <span className="text-[11px] font-mono text-[#64748b] whitespace-nowrap">
              {live ? 'No feed' : status === 'UPCOMING' ? 'Scheduled' : 'Closed'}
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShare(match);
            }}
            title="Share match"
            aria-label={`Share ${match.event_name || eventName(match)}`}
            className="h-7 w-7 rounded-md border border-[#242c3a] bg-[#161b24] hover:border-[#394559] hover:text-white text-[#8e9aaf] grid place-items-center transition-colors cursor-pointer"
          >
            <Share2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </article>
  );
};

const MatchListRow: React.FC<{
  match: MatchItem;
  onSelect: (m: MatchItem) => void;
  onShare: (m: MatchItem) => void;
}> = ({ match, onSelect, onShare }) => {
  const status = matchStatus(match);
  const live = status === 'LIVE';
  const streams = live ? validStreams(match) : [];
  const playable = live && streams.length > 0;
  const info = match.eventInfo || {};
  const a = teamA(match);

  return (
    <div
      onClick={() => onSelect(match)}
      className={`px-4 py-3 flex items-center justify-between gap-4 transition-colors ${
        playable
          ? 'cursor-pointer hover:bg-[#161c27]'
          : 'opacity-75 cursor-default'
      }`}
    >
      <div className="flex items-center gap-3.5 min-w-0">
        <TeamLogo
          primary={info.teamAFlag}
          fallback={info.event_logo}
          teamName={a}
          size="sm"
        />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white truncate">
            {match.event_name || eventName(match)}
          </div>
          <div className="flex items-center gap-2 text-xs text-[#8e9aaf] truncate">
            {live ? (
              <span className="inline-flex items-center gap-1 font-semibold text-[#f87171]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444]" />
                LIVE
              </span>
            ) : (
              <span>{status === 'UPCOMING' ? 'Upcoming' : 'Ended'}</span>
            )}
            <span aria-hidden="true">·</span>
            <span>{match.Category || 'Sports'}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{eventName(match)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2.5 shrink-0">
        <span className="hidden sm:inline font-mono text-xs tabular-nums text-[#64748b] mr-1">
          {timeText(match)}
        </span>
        {playable ? (
          <button
            type="button"
            className="px-3 py-1.5 rounded-md bg-[#10b981]/15 border border-[#10b981]/40 text-[#34d399] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>
              Watch ({streams.length})
            </span>
          </button>
        ) : (
          <span className="text-xs font-mono text-[#64748b] w-20 text-right">
            {live ? 'No feed' : status === 'UPCOMING' ? 'Scheduled' : 'Closed'}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onShare(match);
          }}
          title="Share match"
          aria-label={`Share ${match.event_name || eventName(match)}`}
          className="h-8 w-8 rounded-md border border-[#242c3a] bg-[#161b24] hover:border-[#394559] hover:text-white text-[#8e9aaf] grid place-items-center transition-colors cursor-pointer"
        >
          <Share2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
