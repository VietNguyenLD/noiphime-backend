export const ophimMockPayload = {
  movie: {
    slug: 'mock-ophim-1',
    name: 'Ophim Mock Movie',
    origin_name: 'Ophim Original',
    aliases: ['Ophim Alias'],
    type: 'series',
    year: 2022,
    status: 'ongoing',
    content: 'An epic story from Ophim.',
    poster_url: 'https://img.example.com/poster.jpg',
    thumb_url: 'https://img.example.com/backdrop.jpg',
    trailer_url: 'https://youtube.com/watch?v=abc',
    imdb_id: 'tt1234567',
    tmdb_id: '12345',
    category: [{ name: 'Action', slug: 'action' }],
    country: [{ name: 'Japan', code: 'JP' }],
    tags: [{ name: 'Hero', slug: 'hero' }],
    actors: [{ name: 'Actor A' }, { name: 'Actor B' }],
    directors: [{ name: 'Director X' }],
  },
  episodes: [
    {
      season: 1,
      items: [
        {
          episode: 1,
          name: 'Episode 1',
          servers: [
            {
              name: 'Server A',
              items: [
                { type: 'hls', label: '720p', url: 'https://cdn.example.com/ophim/1.m3u8' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export const kkphimMockPayload = {
  slug: 'mock-kkphim-1',
  title: 'Kkphim Mock Movie',
  original_title: 'Kkphim Original',
  other_titles: ['Kkphim Alias'],
  type: 'single',
  year: 2021,
  status: 'completed',
  plot: 'A suspenseful KK story.',
  poster: 'https://img.example.com/poster2.jpg',
  backdrop: 'https://img.example.com/backdrop2.jpg',
  trailer: 'https://youtube.com/watch?v=def',
  imdb: 'tt7654321',
  tmdb: '54321',
  genres: [{ name: 'Drama', slug: 'drama' }],
  countries: [{ name: 'United States', code: 'US' }],
  tags: [{ name: 'Mystery', slug: 'mystery' }],
  cast: [{ name: 'Actor C' }],
  directors: [{ name: 'Director Y' }],
  writers: [{ name: 'Writer Z' }],
  seasons: [
    {
      number: 1,
      episodes: [
        {
          number: 1,
          name: 'Episode 1',
          streams: [
            {
              server: 'Server B',
              kind: 'mp4',
              label: '1080p',
              url: 'https://cdn.example.com/kk/1.mp4',
            },
          ],
        },
      ],
    },
  ],
};
