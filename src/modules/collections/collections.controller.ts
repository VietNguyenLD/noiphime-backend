import { Controller, Get, Query } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import { CollectionListQueryDto } from './dto/collection-list.query.dto';

@Controller('collection')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get('list')
  async list(@Query() query: CollectionListQueryDto) {
    return this.collectionsService.getCollectionList(query.page, query.limit);
  }
}
