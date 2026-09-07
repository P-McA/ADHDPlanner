export const DEPENDENCY_STATUSES = ['ok', 'error'] as const;
export type DependencyStatus = (typeof DEPENDENCY_STATUSES)[number];

/** Result of probing one backing service. */
export interface DependencyHealth {
  status: DependencyStatus;
  /** Round-trip time of the probe, in milliseconds. */
  latencyMs: number;
  /** Failure reason, or null when the probe succeeded. */
  error: string | null;
}

/**
 * Response shape of `GET /health`. Shared so clients can type the probe.
 *
 * `status` is the roll-up: 'ok' only when every dependency is 'ok'. The route
 * answers 503 when it is 'error', so orchestrator probes act on the status
 * line without parsing the body.
 */
export interface HealthResponse {
  status: DependencyStatus;
  uptimeSeconds: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
  dependencies: {
    postgres: DependencyHealth;
    redis: DependencyHealth;
  };
}
