import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async run() {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.seedSources(queryRunner);
      await queryRunner.commitTransaction();
      this.logger.log('Seeded sources successfully');
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async seedSources(queryRunner: QueryRunner) {
    const sources = [
      { code: 'ophim', baseUrl: 'https://ophim1.com' },
      { code: 'kkphim', baseUrl: 'https://phimapi.com' },
    ];

    for (const source of sources) {
      await queryRunner.query(
        `
        INSERT INTO sources (code, base_url, is_active)
        VALUES ($1, $2, true)
        ON CONFLICT (code)
        DO UPDATE SET base_url = EXCLUDED.base_url, is_active = true;
        `,
        [source.code, source.baseUrl],
      );
    }
  }
}
