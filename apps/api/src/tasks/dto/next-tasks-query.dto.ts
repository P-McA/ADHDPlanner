import { TASK_LIST_DEFAULT_LIMIT, TASK_LIST_MAX_LIMIT } from '@adhd/shared';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query parameters for GET /tasks/next.
 *
 * No `offset`: paging is by `cursor`, the opaque value the previous page
 * returned as `nextCursor`. Its contents are checked in the service, which is
 * the only thing that can read it.
 */
export class NextTasksQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TASK_LIST_MAX_LIMIT)
  limit?: number = TASK_LIST_DEFAULT_LIMIT;

  @IsOptional()
  @IsString()
  cursor?: string;
}
