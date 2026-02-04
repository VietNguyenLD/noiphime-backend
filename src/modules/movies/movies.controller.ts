import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { MoviesService } from './movies.service';
import { MoviesListQueryDto } from './dto/movies-list.dto';

@Controller()
export class MoviesController {
  constructor(private readonly moviesService: MoviesService) {}

  @Get('movies')
  async listMovies(@Query() query: MoviesListQueryDto) {
    return this.moviesService.listMovies(query);
  }

  @Get('movies/:slug')
  async getMovie(@Param('slug') slug: string) {
  
    const movie = await this.moviesService.getMovieBySlug(slug);
      console.log(movie);
    
    if (!movie) {
      throw new NotFoundException('Movie not found');
    }
    return movie;
  }

  @Get('movies/:slug/episodes')
  async getEpisodes(@Param('slug') slug: string) {
    const data = await this.moviesService.getEpisodesBySlug(slug);
    if (!data) {
      throw new NotFoundException('Movie not found');
    }
    return data;
  }

  @Get('episodes/:id/streams')
  async getStreams(@Param('id') id: string) {
    return this.moviesService.getStreamsByEpisodeId(id);
  }
}
