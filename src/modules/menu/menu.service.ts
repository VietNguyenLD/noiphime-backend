import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

interface GenreRow {
  id: number;
  name: string;
  slug: string;
}

interface CountryRow {
  id: number;
  name: string;
  code: string | null;
}

@Injectable()
export class MenuService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async getHeaderMenu() {
    const genres = await this.dataSource.query<GenreRow[]>(
      `SELECT id, name, slug FROM genres ORDER BY name ASC`,
    );
    const countries = await this.dataSource.query<CountryRow[]>(
      `SELECT id, name, code FROM countries ORDER BY name ASC`,
    );

    const types = [
      { key: 'single', label: 'Phim lẻ' },
      { key: 'series', label: 'Phim bộ' },
    ];

    return {
      types,
      genres,
      countries: countries.map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code || null,
      })),
    };
  }
}
