import { PayloadAdapter } from './payload-adapter';
import { MovieNormalized, MovieStatus, SourceItemRow, StreamItem } from '../dto/normalized.dto';
import { slugify } from '../utils/normalize';

export class OphimPayloadAdapter implements PayloadAdapter {
  supports(sourceId: string): boolean {
    return sourceId === 'ophim';
  }

  normalize(payload: any, sourceItem: SourceItemRow): MovieNormalized {
    const title = payload?.movie?.name || sourceItem.title || 'Unknown Title';
    const originalTitle = payload?.movie?.origin_name || null;
    const otherTitles = this.toStringArray(
      payload?.movie?.alternative_names ??
        payload?.movie?.aliases ??
        payload?.movie?.alias ??
        payload?.movie?.other_titles,
    );

    const type = this.mapType(payload?.movie);
    const status = this.mapStatus(payload?.movie?.status);
    const durationMin = this.parseDuration(payload?.movie?.time);
    const ratingAvg =
      this.toNumber(payload?.movie?.tmdb?.vote_average) ??
      this.toNumber(payload?.movie?.imdb?.vote_average) ??
      null;
    const ratingCount =
      this.toNumber(payload?.movie?.tmdb?.vote_count) ??
      this.toNumber(payload?.movie?.imdb?.vote_count) ??
      null;
    const viewCount = this.toNumber(payload?.movie?.view);

    return {
      slugSuggested: slugify(payload?.movie?.slug || title),
      title,
      originalTitle,
      otherTitles,
      type,
      year: payload?.movie?.year || sourceItem.year || null,
      status,
      durationMin,
      quality: payload?.movie?.quality || null,
      language: payload?.movie?.lang || null,
      subtitle: payload?.movie?.lang || null,
      viewCount,
      ratingAvg,
      ratingCount,
      plot: payload?.movie?.content || null,
      posterUrl: payload?.movie?.poster_url || null,
      backdropUrl: payload?.movie?.thumb_url || null,
      trailerUrl: payload?.movie?.trailer_url || null,
      imdbId: payload?.movie?.imdb?.id || payload?.movie?.imdb_id || null,
      tmdbId: payload?.movie?.tmdb?.id || payload?.movie?.tmdb_id || null,
      genres: (payload?.movie?.category || []).map((g: any) => ({ name: g.name || g, slug: g.slug })),
      countries: (payload?.movie?.country || []).map((c: any) => {
        const name = c?.name || c;
        const slug = c?.slug || null;
        const code = c?.code || slug || null;
        return { name, code, slug };
      }),
      tags: (payload?.movie?.tags || []).map((t: any) => ({ name: t.name || t, slug: t.slug })),
      people: {
        actors: this.toStringArray(payload?.movie?.actor ?? payload?.movie?.actors).map((p) => ({ name: p })),
        directors: this.toStringArray(payload?.movie?.director ?? payload?.movie?.directors).map((p) => ({
          name: p,
        })),
      },
      seasons: this.normalizeSeasons(payload),
    };
  }

  private toStringArray(input: unknown): string[] {
    if (Array.isArray(input)) {
      return input.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof input === 'string') {
      const value = input.trim();
      return value ? [value] : [];
    }
    if (input && typeof input === 'object') {
      return Object.values(input as Record<string, unknown>)
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    }
    return [];
  }

  private mapStatus(status: string | undefined | null): MovieStatus {
    if (!status) return 'unknown';
    if (status === 'ongoing') return 'ongoing';
    if (status === 'completed') return 'completed';
    if (status === 'upcoming') return 'upcoming';
    return 'unknown';
  }

  private mapType(movie: any): 'single' | 'series' {
    const raw = String(movie?.type || '').toLowerCase().trim();
    if (
      raw === 'series' ||
      raw === 'tv' ||
      raw === 'phimbo' ||
      raw === 'phim-bo' ||
      raw === 'hoathinh'
    )
      return 'series';
    if (raw === 'single' || raw === 'movie' || raw === 'phimle' || raw === 'phim-le') return 'single';
    if (movie?.episode_total || movie?.episode_current) return 'series';
    return 'single';
  }

  private parseDuration(value: unknown): number | null {
    if (!value) return null;
    const text = String(value);
    const match = text.match(/(\d+)/);
    return match ? Number(match[1]) : null;
  }

  private toNumber(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  private normalizeSeasons(payload: any) {
    const servers = payload?.episodes || [];
    if (!servers.length) return [];

    const seasonNumber = payload?.movie?.tmdb?.season || 1;
    const byKey = new Map<string, { episodeNumber: number; name: string; streams: StreamItem[] }>();

    servers.forEach((server: any) => {
      const serverName = server?.server_name || 'Server';
      const items = server?.server_data || [];
      items.forEach((ep: any) => {
        const rawNumber = ep?.name || ep?.slug || ep?.filename || '';
        const parsedNumber = Number(String(rawNumber).match(/\d+/)?.[0] || 1);
        const key = String(ep?.slug || ep?.name || ep?.filename || parsedNumber);
        const entry =
          byKey.get(key) ?? {
            episodeNumber: parsedNumber,
            name: ep?.filename || ep?.name || `Episode ${parsedNumber}`,
            streams: [] as StreamItem[],
          };

        if (ep?.link_m3u8) {
          entry.streams.push({
            serverName,
            kind: 'hls',
            label: 'HLS',
            url: ep.link_m3u8,
            headers: null,
            priority: null,
          });
        }

        if (ep?.link_embed) {
          entry.streams.push({
            serverName,
            kind: 'embed',
            label: 'Embed',
            url: ep.link_embed,
            headers: null,
            priority: null,
          });
        }

        byKey.set(key, entry);
      });
    });

    const normalized = Array.from(byKey.values()).sort((a, b) => a.episodeNumber - b.episodeNumber);

    return [
      {
        seasonNumber,
        episodes: normalized,
      },
    ];
  }
}
