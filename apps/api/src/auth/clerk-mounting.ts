/**
 * The one decision main.ts makes about Clerk, extracted so it can be tested.
 *
 * `clerkMiddleware()` is not defensive about its configuration: with no
 * publishable key it calls `next(err)` on *every* request, before any route or
 * guard runs, so an Express error handler answers 500 to the whole API —
 * `GET /health` included. Mounting it on a server that has no key therefore
 * buys nothing (it could not verify a session anyway) and costs everything.
 *
 * So the rule is simply: mount it when there is a key that could work, and
 * leave it off otherwise. What happens to a request on a server without it is
 * `ClerkAuthGuard`'s business, and the answer there is 401 — see the note on
 * `clerkSubject`. That pair is what makes "no Clerk keys" a signed-out server
 * rather than a broken one.
 *
 * This deliberately does not consult `devBypassArmed()`. The previous rule did
 * (`clerkKeyLooksUsable() || !devBypassArmed()`), which mounted the middleware
 * whenever the bypass was off — including the no-key case that the rule existed
 * to protect against. The bypass is about who may sign in, not about whether a
 * key exists, and mixing the two is what hid the 500.
 */
export function shouldMountClerk(): boolean {
  // A shape check, not a validity check: it exists to tell a genuine key from
  // an absent one or from the `pk_test_...` placeholder in .env.example, so a
  // developer who has never configured Clerk gets a working server. Clerk still
  // does the real parsing and verification.
  return /^pk_(test|live)_[\w+/=-]+$/.test(process.env.CLERK_PUBLISHABLE_KEY ?? '');
}
