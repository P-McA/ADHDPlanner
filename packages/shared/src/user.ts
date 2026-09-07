/**
 * Phase 0 user contract. Identity itself is owned by Clerk; this is the
 * application-side projection of a user, keyed by Clerk's subject id.
 */
export interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  /** IANA zone name, e.g. "Europe/London". */
  timezone: string;
  createdAt: string;
}
