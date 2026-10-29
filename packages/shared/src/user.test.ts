import { describe, expect, it } from 'vitest';

import { isIanaTimeZone } from './user.js';

describe('isIanaTimeZone', () => {
  it.each(['Europe/London', 'Pacific/Auckland', 'America/Argentina/Buenos_Aires', 'Etc/GMT+12', 'UTC'])(
    'accepts %s',
    (zone) => {
      expect(isIanaTimeZone(zone)).toBe(true);
    },
  );

  it.each(['', 'Mars/Olympus_Mons', '+01:00', 'GMT+1', '../etc/passwd', 'Europe/London '])(
    'refuses %j',
    (zone) => {
      expect(isIanaTimeZone(zone)).toBe(false);
    },
  );
});
