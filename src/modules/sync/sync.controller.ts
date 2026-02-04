import { Controller, NotFoundException, Param, Post } from '@nestjs/common';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('source-items/:id')
  async syncSourceItem(@Param('id') id: string) {
    const result = await this.syncService.syncSourceItem(Number(id));
    if (!result) {
      throw new NotFoundException('Source item not found');
    }
    return result;
  }
}
