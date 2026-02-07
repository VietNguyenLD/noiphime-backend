import { Controller, Param, Post, Query } from '@nestjs/common';
import { CrawlService } from './crawl.service';

@Controller('crawl')
export class CrawlController {
  constructor(private readonly crawlService: CrawlService) {}

  @Post(':source/discover')
  async discover(
    @Param('source') source: string,
    @Query('page') page?: string,
    @Query('inline') inline?: string,
  ) {
    const pageNum = page ? Number(page) : 1;
    if (inline === '1' || inline === 'true') {
      return this.crawlService.discover(source, pageNum);
    }
    return this.crawlService.enqueueDiscover(source, pageNum);
  }

  @Post(':source/detail/:externalId')
  async detail(
    @Param('source') source: string,
    @Param('externalId') externalId: string,
    @Query('inline') inline?: string,
  ) {
    if (inline === '1' || inline === 'true') {
      return this.crawlService.detail(source, externalId);
    }
    return this.crawlService.enqueueDetail(source, externalId);
  }
}
