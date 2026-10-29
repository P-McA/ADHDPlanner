import { render, waitFor } from '@testing-library/react-native';
import type * as NotificationsModule from 'expo-notifications';
import { Platform } from 'react-native';

import type * as ApiClientModule from '../lib/api-client';
import * as api from '../lib/api-client';
import { PushRegistrar } from './push-registrar';

type ApiClient = typeof ApiClientModule;

/**
 * The phone asking for a push token. Our own module is mocked; that the token
 * really reaches the table is the API's notification suite, which registers
 * through the same route.
 */

jest.mock('../lib/api-client', () => {
  const actual = jest.requireActual<ApiClient>('../lib/api-client');

  return { ...actual, registerPushToken: jest.fn() };
});

let mockIsDevice = true;

jest.mock('expo-device', () => ({
  // A getter so a test can pretend to be a simulator.
  get isDevice() {
    return mockIsDevice;
  },
}));

let mockProjectId: string | undefined = 'project-1';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    // A getter so a test can take the project id away without re-importing.
    get expoConfig() {
      return { extra: { eas: { projectId: mockProjectId } } };
    },
  },
}));

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
}));

const Notifications = jest.requireMock<typeof NotificationsModule>('expo-notifications');
const getPermissionsAsync = Notifications.getPermissionsAsync as jest.MockedFunction<
  typeof Notifications.getPermissionsAsync
>;
const requestPermissionsAsync = Notifications.requestPermissionsAsync as jest.MockedFunction<
  typeof Notifications.requestPermissionsAsync
>;
const getExpoPushTokenAsync = Notifications.getExpoPushTokenAsync as jest.MockedFunction<
  typeof Notifications.getExpoPushTokenAsync
>;
const registerPushToken = api.registerPushToken as jest.MockedFunction<
  typeof api.registerPushToken
>;

const originalPlatform = Platform.OS;

function setPlatform(os: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatform('ios');
  mockIsDevice = true;
  mockProjectId = 'project-1';
  registerPushToken.mockResolvedValue({
    id: 'p1',
    token: 'ExponentPushToken[abc]',
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
  });
  getPermissionsAsync.mockResolvedValue({ status: 'granted' } as never);
  requestPermissionsAsync.mockResolvedValue({ status: 'granted' } as never);
  getExpoPushTokenAsync.mockResolvedValue({
    data: 'ExponentPushToken[abc]',
  } as never);
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('PushRegistrar', () => {
  it('registers the device token when permission is granted', async () => {
    await render(<PushRegistrar />);

    await waitFor(() => {
      expect(registerPushToken).toHaveBeenCalledWith({ token: 'ExponentPushToken[abc]' });
    });
  });

  it('asks for permission when it has not been decided yet', async () => {
    getPermissionsAsync.mockResolvedValue({ status: 'undetermined' } as never);

    await render(<PushRegistrar />);

    await waitFor(() => {
      expect(requestPermissionsAsync).toHaveBeenCalled();
    });
  });

  it('does nothing when permission is refused', async () => {
    getPermissionsAsync.mockResolvedValue({ status: 'denied' } as never);
    requestPermissionsAsync.mockResolvedValue({ status: 'denied' } as never);

    await render(<PushRegistrar />);

    await waitFor(() => {
      expect(getExpoPushTokenAsync).not.toHaveBeenCalled();
    });
    expect(registerPushToken).not.toHaveBeenCalled();
  });

  it('does nothing on a simulator, which has no push token', async () => {
    mockIsDevice = false;

    await render(<PushRegistrar />);

    await waitFor(() => {
      expect(getPermissionsAsync).not.toHaveBeenCalled();
    });
  });

  it('does nothing on web', async () => {
    setPlatform('web');

    await render(<PushRegistrar />);

    await waitFor(() => {
      expect(getPermissionsAsync).not.toHaveBeenCalled();
    });
  });

  it('does nothing without an EAS project id', async () => {
    mockProjectId = undefined;

    await render(<PushRegistrar />);

    await waitFor(() => {
      expect(getExpoPushTokenAsync).not.toHaveBeenCalled();
    });
  });

  it('swallows a registration failure rather than showing one', async () => {
    registerPushToken.mockRejectedValue(new api.ApiError(0, 'Cannot reach the API'));

    await render(<PushRegistrar />);

    await waitFor(() => {
      expect(registerPushToken).toHaveBeenCalled();
    });
  });
});
