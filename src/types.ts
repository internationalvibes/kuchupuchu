export type StreamProtocol = 'DASH' | 'HLS' | 'DIRECT';

export interface StreamSource {
  tokenId: string;
  channel_name?: string;
  protocol: StreamProtocol;
  hasDrm?: boolean;
}

export interface EventInfo {
  eventName?: string;
  event_logo?: string;
  teamA?: string;
  teamB?: string;
  teamAFlag?: string;
  teamBFlag?: string;
  startTime?: string;
}

export interface MatchItem {
  event_name?: string;
  status?: string;
  Category?: string;
  eventInfo?: EventInfo;
  streams?: StreamSource[];
}

export interface SportsFeedResponse {
  matches?: MatchItem[];
  live_match?: number;
  total_matches?: number;
  last_update_time?: string;
}

export type MatchStatusType = 'LIVE' | 'UPCOMING' | 'ENDED';
export type StatusFilter = 'ALL' | MatchStatusType;
export type SportTab = 'CRICKET' | 'FOOTBALL' | 'OTHERS';
export type SortOption = 'default' | 'live' | 'name';
export type ViewMode = 'grid' | 'list';
export type AspectFitMode = 'contain' | 'cover' | '16:9' | '4:3';

export interface QualityOption {
  index: number; // -1 for Auto
  label: string;
  height?: number;
  bitrate?: number;
}

export interface AudioTrackOption {
  index: number;
  label: string;
  lang?: string;
}

export interface PlayerTelemetry {
  protocol: string;
  resolution: string;
  bitrateMbps: string;
  bufferSeconds: number;
  droppedFrames: number;
  playbackState: string;
}
