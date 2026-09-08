import {
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_INCLUDES,
  TASK_LIST_MAX_LIMIT,
  TASK_STATUSES,
  type ListTasksQuery,
  type TaskListInclude,
  type TaskStatus,
} from '@adhd/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query parameters for GET /tasks.
 *
 * `@Type(() => Number)` is required because query strings arrive as strings and
 * @IsInt would otherwise reject every limit. Max is enforced as a 400 rather
 * than silently clamping, so a client asking for 500 learns that it cannot.
 */
export class ListTasksQueryDto implements ListTasksQuery {
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: TaskStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TASK_LIST_MAX_LIMIT)
  limit?: number = TASK_LIST_DEFAULT_LIMIT;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;

  // Rejected with a 400 rather than ignored when it is anything but 'drafts':
  // a client that misspells this would otherwise silently get the fenced page
  // and conclude the user has no suggestions waiting.
  @IsOptional()
  @IsIn(TASK_LIST_INCLUDES)
  include?: TaskListInclude;
}
