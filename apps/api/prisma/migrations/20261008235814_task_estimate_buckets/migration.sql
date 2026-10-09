-- Both estimate columns hold one of ESTIMATE_BUCKETS (packages/shared/src/estimation.ts)
-- or nothing. The API validates this too; the constraint is what makes "37 minutes"
-- impossible to store whatever path a write takes. Keep the list in step with the
-- shared constant: changing the buckets is a migration, on purpose.
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_estimate_minutes_bucket"
    CHECK ("estimate_minutes" IS NULL OR "estimate_minutes" IN (5, 15, 30, 60, 120, 240)),
  ADD CONSTRAINT "tasks_suggested_estimate_minutes_bucket"
    CHECK ("suggested_estimate_minutes" IS NULL OR "suggested_estimate_minutes" IN (5, 15, 30, 60, 120, 240));
