/** Response shape of `GET /health`. Shared so clients can type the probe. */
export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
}
