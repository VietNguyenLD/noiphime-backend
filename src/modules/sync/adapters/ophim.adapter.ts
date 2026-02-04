import { PayloadAdapter } from './payload-adapter';
import { MovieNormalized, MovieStatus, SourceItemRow } from '../dto/normalized.dto';
import { normalizeTitle, slugify } from '../utils/normalize';

export class OphimPayloadAdapter implements PayloadAdapter {
  supports(sourceId: string): boolean {
    return sourceId === 'ophim';
  }

  normalize(payload: any, sourceItem: SourceItemRow): MovieNormalized {
    const title = payload?.movie?.name || sourceItem.title || 'Unknown Title';
    const originalTitle = payload?.movie?.origin_name || null;
    const otherTitles = payload?.movie?.aliases || [];

    const type = payload?.movie?.type === 'series' ? 'series' : 'single';
    const status = this.mapStatus(payload?.movie?.status);

    return {
      slugSuggested: slugify(payload?.movie?.slug || title),
      title,
      originalTitle,
      otherTitles,
      type,
      year: payload?.movie?.year || sourceItem.year || null,
      status,
      plot: payload?.movie?.content || null,
      posterUrl: payload?.movie?.poster_url || null,
      backdropUrl: payload?.movie?.thumb_url || null,
      trailerUrl: payload?.movie?.trailer_url || null,
      imdbId: payload?.movie?.imdb_id || null,
      tmdbId: payload?.movie?.tmdb_id || null,
      genres: (payload?.movie?.category || []).map((g: any) => ({ name: g.name || g, slug: g.slug })),
      countries: (payload?.movie?.country || []).map((c: any) => ({ name: c.name || c, code: c.code })),
      tags: (payload?.movie?.tags || []).map((t: any) => ({ name: t.name || t, slug: t.slug })),
      people: {
        actors: (payload?.movie?.actors || []).map((p: any) => ({ name: p.name || p })),
        directors: (payload?.movie?.directors || []).map((p: any) => ({ name: p.name || p })),
      },
      seasons: this.normalizeSeasons(payload),
    };
  }

  private mapStatus(status: string | undefined | null): MovieStatus {
    if (!status) return 'unknown';
    if (status === 'ongoing') return 'ongoing';
    if (status === 'completed') return 'completed';
    if (status === 'upcoming') return 'upcoming';
    return 'unknown';
  }

  private normalizeSeasons(payload: any) {
    const episodes = payload?.episodes || [];
    if (!episodes.length) return [];

    return episodes.map((season: any, idx: number) => ({
      seasonNumber: season?.season || idx + 1,
      episodes: (season?.items || []).map((ep: any) => ({
        episodeNumber: Number(ep?.episode || ep?.number || 1),
        name: ep?.name || `Episode ${ep?.episode || ep?.number || 1}`,
        streams: (ep?.servers || []).flatMap((server: any) =>
          (server?.items || []).map((stream: any) => ({
            serverName: server?.name || 'Server',
            kind: stream?.type || 'hls',
            label: stream?.label || stream?.name || 'Default',
            url: stream?.url || '',
            headers: stream?.headers || null,
            priority: stream?.priority || null,
          })),
        ),
      })),
    }));
  }
}
