import { Controller, Get, Query } from '@nestjs/common';
import { SliderService } from './slider.service';
import { SliderQueryDto } from './dto/slider.query.dto';

@Controller('slider')
export class SliderController {
  constructor(private readonly sliderService: SliderService) {}

  @Get('home')
  async home(@Query() query: SliderQueryDto) {
    return this.sliderService.getHomeSlider(query);
  }
}
