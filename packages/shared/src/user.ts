/**
 * User contract. Identity itself is owned by Clerk; this is the
 * application-side projection of a user, linked to it by `clerkId`.
 */
export interface User {
  /** Internal UUID primary key. This is what `Task.userId` references. */
  id: string;
  /** Clerk's subject id (`user_...`) — the link back to the identity provider. */
  clerkId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  /** IANA zone name, e.g. "Europe/London". */
  timezone: string;
  createdAt: string;
}
