export type MediaType = 'single' | 'series';
export type MovieStatus = 'ongoing' | 'completed' | 'upcoming' | 'unknown';
export type VideoKind = 'embed' | 'hls' | 'mp4' | 'external';

export interface TaxonomyItem {
  name: string;
  slug?: string;
  code?: string;
}

export interface PersonItem {
  name: string;
  slug?: string;
  avatarUrl?: string;
  bio?: string;
}

export interface StreamItem {
  serverName: string;
  kind: VideoKind;
  label: string;
  url: string;
  headers?: Record<string, string> | null;
  priority?: number | null;
}

export interface EpisodeItem {
  episodeNumber: number;
  name: string;
  streams: StreamItem[];
}

export interface SeasonItem {
  seasonNumber: number;
  episodes: EpisodeItem[];
}

export interface PeopleBlock {
  actors: PersonItem[];
  directors: PersonItem[];
  writers?: PersonItem[];
  producers?: PersonItem[];
}

export interface MovieNormalized {
  slugSuggested: string;
  title: string;
  originalTitle?: string | null;
  otherTitles?: string[] | null;
  type: MediaType;
  year?: number | null;
  status?: MovieStatus | null;
  durationMin?: number | null;
  quality?: string | null;
  subtitle?: string | null;
  viewCount?: number | null;
  ratingAvg?: number | null;
  ratingCount?: number | null;
  plot?: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  trailerUrl?: string | null;
  imdbId?: string | null;
  tmdbId?: string | null;
  genres: TaxonomyItem[];
  countries: TaxonomyItem[];
  tags: TaxonomyItem[];
  people: PeopleBlock;
  seasons: SeasonItem[];
}

export interface SourceItemRow {
  id: number;
  source_id: number;
  source_code: string;
  external_id: string | null;
  type: string | null;
  title: string | null;
  year: number | null;
  payload: any;
  content_hash: string | null;
}
