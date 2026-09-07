import {
  TASK_PRIORITIES,
  TASK_SOURCES,
  TASK_TITLE_MAX_LENGTH,
  TASK_TITLE_MIN_LENGTH,
  type CreateTaskInput,
  type TaskPriority,
  type TaskSource,
} from '@adhd/shared';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/**
 * Implements the shared CreateTaskInput contract.
 *
 * The enum validators are driven off the shared constant arrays rather than a
 * literal list, so adding a value in packages/shared cannot leave the API
 * silently rejecting it.
 */
export class CreateTaskDto implements CreateTaskInput {
  @IsString()
  @Length(TASK_TITLE_MIN_LENGTH, TASK_TITLE_MAX_LENGTH)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  manualPriority?: TaskPriority;

  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  @IsOptional()
  @IsIn(TASK_SOURCES)
  source?: TaskSource;

  /**
   * Ownership of the referenced parent is checked in the service, not here —
   * validation cannot see the caller's identity.
   */
  @IsOptional()
  @IsUUID()
  parentTaskId?: string;
}
