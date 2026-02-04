import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class MoviesListQueryDto {
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;

  @IsOptional()
  @IsIn(['popular', 'new', 'updated'])
  sort?: 'popular' | 'new' | 'updated';

  @IsOptional()
  @IsIn(['single', 'series'])
  type?: 'single' | 'series';

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  year?: number;

  @IsOptional()
  @IsIn(['ongoing', 'completed', 'upcoming'])
  status?: 'ongoing' | 'completed' | 'upcoming';

  @IsOptional()
  @IsString()
  genre?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  q?: string;
}
