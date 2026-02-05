import { PayloadAdapter } from './payload-adapter';
import { MovieNormalized, MovieStatus, SourceItemRow } from '../dto/normalized.dto';
import { slugify } from '../utils/normalize';

export class KkphimPayloadAdapter implements PayloadAdapter {
  supports(sourceId: string): boolean {
    return sourceId === 'kkphim';
  }

  normalize(payload: any, sourceItem: SourceItemRow): MovieNormalized {
    const movie = payload?.movie || {};
    const title = movie?.name || sourceItem.title || 'Unknown Title';
    const originalTitle = movie?.origin_name || null;
    const durationMin = this.parseDuration(movie?.time);
    const ratingAvg =
      this.toNumber(movie?.tmdb?.vote_average) ?? this.toNumber(movie?.imdb?.vote_average) ?? null;
    const ratingCount =
      this.toNumber(movie?.tmdb?.vote_count) ?? this.toNumber(movie?.imdb?.vote_count) ?? null;
    const viewCount = this.toNumber(movie?.view);

    return {
      slugSuggested: slugify(movie?.slug || title),
      title,
      originalTitle,
      otherTitles: [],
      type: this.mapType(movie),
      year: movie?.year || sourceItem.year || null,
      status: this.mapStatus(movie?.status),
      durationMin,
      quality: movie?.quality || null,
      language: movie?.lang || null,
      subtitle: movie?.lang || null,
      viewCount,
      ratingAvg,
      ratingCount,
      plot: movie?.content || null,
      posterUrl: movie?.poster_url || null,
      backdropUrl: movie?.thumb_url || null,
      trailerUrl: movie?.trailer_url || null,
      imdbId: movie?.imdb?.id || null,
      tmdbId: movie?.tmdb?.id || null,
      genres: (movie?.category || []).map((g: any) => ({ name: g.name || g, slug: g.slug })),
      countries: (movie?.country || []).map((c: any) => {
        const name = c.name || c;
        const rawCode = c.slug || c.code || null;
        const code = rawCode && String(rawCode).length <= 10 ? String(rawCode) : null;
        return { name, code };
      }),
      tags: [],
      people: {
        actors: this.filterPeople(movie?.actor || []),
        directors: this.filterPeople(movie?.director || []),
        writers: [],
      },
      seasons: this.normalizeSeasons(payload, movie?.type),
    };
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

  private normalizeSeasons(payload: any, type: string) {
    const episodes = payload?.episodes || [];
    if (!episodes.length) return [];

    const seasonNumber = type === 'series' ? 1 : 1;
    const items: MovieNormalized['seasons'][number]['episodes'] = [];

    for (const server of episodes) {
      const serverName = server?.server_name || 'Server';
      const serverItems = server?.server_data || [];

      for (const item of serverItems) {
        const episodeName = item?.name || item?.filename || 'Episode';
        const episodeNumber = this.parseEpisodeNumber(episodeName);

        const streams: MovieNormalized['seasons'][number]['episodes'][number]['streams'] = [];
        if (item?.link_m3u8) {
          streams.push({
            serverName,
            kind: 'hls' as const,
            label: 'm3u8',
            url: item.link_m3u8,
            priority: 100,
          });
        }
        if (item?.link_embed) {
          streams.push({
            serverName,
            kind: 'hls' as const,
            label: 'embed',
            url: item.link_embed,
            priority: 80,
          });
        }

        items.push({
          episodeNumber,
          name: episodeName,
          streams,
        });
      }
    }

    return [
      {
        seasonNumber,
        episodes: items,
      },
    ];
  }

  private filterPeople(list: any[]) {
    return list
      .map((p: any) => (typeof p === 'string' ? p : p?.name))
      .filter((name: string) => name && name !== 'Đang cập nhật')
      .map((name: string) => ({ name }));
  }

  private parseEpisodeNumber(label: string): number {
    const match = label.match(/(\d+)/);
    return match ? Number(match[1]) : 1;
  }
}
