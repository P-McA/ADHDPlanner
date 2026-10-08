/**
 * The three environment variables this app reads, declared once.
 *
 * Metro inlines `EXPO_PUBLIC_*` into the bundle at build time — the React
 * Native analogue of Next's `NEXT_PUBLIC_*` — so `process.env` here is a frozen
 * object rather than the machine's environment. There is no `.env` at runtime
 * on a phone, and a variable that was never set is simply absent, which is why
 * every one of these is optional.
 *
 * Declaring them buys two things. The ambient `ProcessEnv` in scope carries an
 * `any` index signature, so without this every read would be an untyped value
 * that the `no-unsafe-*` lint rules cannot help with; and the list of what the
 * client is configured by stops living only in `.env.example`.
 *
 * None of these may ever be a secret. The bundle ships to the device and can be
 * read by anyone holding the app — see `api-client.ts` on why the dev flag
 * decides only what the client *sends*.
 */
declare namespace NodeJS {
  interface ProcessEnv {
    /** Where the API lives, e.g. `http://192.168.1.10:3001`. */
    EXPO_PUBLIC_API_URL?: string;
    /** `'true'` to send the development sign-in header. Nothing else counts. */
    EXPO_PUBLIC_DEV_MODE?: string;
    /** The label the dev header carries; the API provisions `dev_<label>`. */
    EXPO_PUBLIC_DEV_USER?: string;
    /**
     * The Clerk instance's *publishable* key (`pk_…`). Public by design; with
     * it set, the app requires a real Clerk session. The secret key belongs
     * only in the API's .env.
     */
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?: string;
  }
}
