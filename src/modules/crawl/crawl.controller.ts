import { Controller, Param, Post, Query } from '@nestjs/common';
import { CrawlService } from './crawl.service';

@Controller('crawl')
export class CrawlController {
  constructor(private readonly crawlService: CrawlService) {}

  @Post(':source/discover')
  async discover(@Param('source') source: string, @Query('page') page?: string) {
    return this.crawlService.enqueueDiscover(source, page ? Number(page) : 1);
  }

  @Post(':source/detail/:externalId')
  async detail(@Param('source') source: string, @Param('externalId') externalId: string) {
    return this.crawlService.enqueueDetail(source, externalId);
  }
}
