import { isIanaTimeZone } from '@adhd/shared';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { updateProfile } from '../lib/api-client';

/** The zone the phone is set to, or null when the runtime cannot say. */
function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone as string | undefined;

    return typeof zone === 'string' && isIanaTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/**
 * Tells the API which zone the phone is in, on launch and on coming back to
 * the foreground. Renders nothing.
 *
 * "Today" is decided on the server from the profile's zone (Next up, streaks,
 * reminders), while Quick add stamps "Today" at 23:59 on the phone's clock.
 * They agree only if the profile holds the phone's zone, and until this
 * existed nothing ever wrote it — every account sat on UTC.
 *
 * Only a changed zone is sent, so returning to the app costs nothing unless
 * someone has travelled. A failed report is forgotten rather than remembered,
 * so the next foreground tries again. It never shows an error: the user cannot
 * act on it, and the app works on the old zone meanwhile.
 */
export function TimeZoneReporter() {
  useEffect(() => {
    let reported: string | null = null;

    const report = () => {
      const zone = deviceTimeZone();

      if (zone === null || zone === reported) return;

      reported = zone;
      updateProfile({ timezone: zone }).catch(() => {
        if (reported === zone) reported = null;
      });
    };

    report();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') report();
    });

    return () => {
      subscription.remove();
    };
  }, []);

  return null;
}
