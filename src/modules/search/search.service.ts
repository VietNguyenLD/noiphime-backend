import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processSearchQueue() {
    try {
      await this.dataSource.query('SELECT process_movie_search_queue($1);', [500]);
    } catch (error) {
      this.logger.warn('Search queue function not ready or failed.');
    }
  }
}
