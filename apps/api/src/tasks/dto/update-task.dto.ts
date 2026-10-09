import {
  ESTIMATE_BUCKETS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
  TASK_TITLE_MIN_LENGTH,
  type EstimateMinutes,
  type TaskPriority,
  type TaskStatus,
  type UpdateTaskInput,
} from '@adhd/shared';
import { IsIn, IsISO8601, IsOptional, IsString, Length } from 'class-validator';

/**
 * Implements the shared UpdateTaskInput contract.
 *
 * Deliberately has no `source` or `parentTaskId`: provenance is immutable once
 * set, and re-parenting stays closed until cycle detection exists. With the
 * global ValidationPipe running `forbidNonWhitelisted`, sending either field
 * is a 400 rather than a silent no-op.
 */
export class UpdateTaskDto implements UpdateTaskInput {
  @IsOptional()
  @IsString()
  @Length(TASK_TITLE_MIN_LENGTH, TASK_TITLE_MAX_LENGTH)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: TaskStatus;

  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  manualPriority?: TaskPriority;

  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  /**
   * The user's own estimate; null clears it. `suggestedEstimateMinutes` is not
   * here on purpose — only the model writes it — so sending it is a 400.
   */
  @IsOptional()
  @IsIn(ESTIMATE_BUCKETS)
  estimateMinutes?: EstimateMinutes | null;
}
