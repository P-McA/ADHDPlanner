import type { User } from '@adhd/shared';
import { render, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import type * as ApiClientModule from '../lib/api-client';
import * as api from '../lib/api-client';
import { TimeZoneReporter } from './time-zone-reporter';

type ApiClient = typeof ApiClientModule;

/**
 * The phone telling the API which zone it is in. Our own module is mocked;
 * that `updateProfile` really changes what "today" means on the server is
 * `reports the phone's time zone…` in the API's mobile-client e2e.
 */

jest.mock('../lib/api-client', () => {
  const actual = jest.requireActual<ApiClient>('../lib/api-client');

  return { ...actual, updateProfile: jest.fn() };
});

const updateProfile = api.updateProfile as jest.MockedFunction<typeof api.updateProfile>;

let zone: string | undefined;
let onAppState: ((state: AppStateStatus) => void) | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  updateProfile.mockResolvedValue({ timezone: 'x' } as User);
  zone = 'Europe/London';
  onAppState = undefined;

  jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(
    () => ({ timeZone: zone }) as Intl.ResolvedDateTimeFormatOptions,
  );
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    onAppState = handler;

    return { remove: jest.fn() };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TimeZoneReporter', () => {
  it('reports the phone’s zone when the app opens', async () => {
    await render(<TimeZoneReporter />);

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith({ timezone: 'Europe/London' });
    });
  });

  it('reports again on returning to the app only when the zone has changed — someone travelled', async () => {
    await render(<TimeZoneReporter />);
    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledTimes(1);
    });

    onAppState!('active');
    expect(updateProfile).toHaveBeenCalledTimes(1);

    zone = 'America/New_York';
    onAppState!('active');

    await waitFor(() => {
      expect(updateProfile).toHaveBeenLastCalledWith({ timezone: 'America/New_York' });
    });
    expect(updateProfile).toHaveBeenCalledTimes(2);
  });

  it('tries again next time after a failed report, rather than believing it landed', async () => {
    updateProfile.mockRejectedValueOnce(new api.ApiError(0, 'Cannot reach the API'));
    await render(<TimeZoneReporter />);
    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledTimes(1);
    });

    onAppState!('active');

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledTimes(2);
    });
  });

  it.each([undefined, '+01:00'])('sends nothing when the phone’s zone is %j', async (value) => {
    zone = value;
    await render(<TimeZoneReporter />);

    onAppState!('active');

    expect(updateProfile).not.toHaveBeenCalled();
  });
});
