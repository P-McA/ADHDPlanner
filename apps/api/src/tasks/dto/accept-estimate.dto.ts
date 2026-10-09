import { ESTIMATE_BUCKETS, type AcceptEstimateInput, type EstimateMinutes } from '@adhd/shared';
import { IsIn, IsOptional } from 'class-validator';

/**
 * Body of POST /tasks/:id/estimate/accept. Empty takes the suggestion as it
 * is; `minutes` corrects it to another bucket. Either way it pays the same, so
 * agreeing with the model is never worth more than disagreeing.
 */
export class AcceptEstimateDto implements AcceptEstimateInput {
  @IsOptional()
  @IsIn(ESTIMATE_BUCKETS)
  minutes?: EstimateMinutes;
}
