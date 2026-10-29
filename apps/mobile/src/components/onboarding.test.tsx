import type { User } from '@adhd/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type * as ApiClientModule from '../lib/api-client';
import * as api from '../lib/api-client';
import { Onboarding } from './onboarding';

type ApiClient = typeof ApiClientModule;

jest.mock('../lib/api-client', () => {
  const actual = jest.requireActual<ApiClient>('../lib/api-client');

  return { ...actual, getMe: jest.fn(), markOnboarded: jest.fn() };
});

const getMe = api.getMe as jest.MockedFunction<typeof api.getMe>;
const markOnboarded = api.markOnboarded as jest.MockedFunction<typeof api.markOnboarded>;

const user = (over: Partial<User> = {}): User => ({
  id: 'u1',
  clerkId: 'clerk_u1',
  email: 'u1@test.local',
  name: null,
  avatarUrl: null,
  timezone: 'UTC',
  onboardedAt: null,
  createdAt: '2026-10-29T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  getMe.mockResolvedValue(user());
  markOnboarded.mockResolvedValue(user({ onboardedAt: '2026-10-29T00:00:00.000Z' }));
});

describe('Onboarding', () => {
  it('shows the explanation to an account that has not seen it', async () => {
    await render(<Onboarding />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding')).toBeTruthy();
    });
  });

  it('stays out of the way once it has been seen', async () => {
    getMe.mockResolvedValue(user({ onboardedAt: '2026-10-01T00:00:00.000Z' }));

    await render(<Onboarding />);

    await waitFor(() => {
      expect(getMe).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('onboarding')).toBeNull();
  });

  it('dismisses and marks it seen', async () => {
    await render(<Onboarding />);
    await waitFor(() => {
      expect(screen.getByTestId('onboarding')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('onboarding-dismiss'));

    expect(screen.queryByTestId('onboarding')).toBeNull();
    expect(markOnboarded).toHaveBeenCalled();
  });

  it('still goes away when marking it seen fails', async () => {
    markOnboarded.mockRejectedValue(new api.ApiError(0, 'Cannot reach the API'));
    await render(<Onboarding />);
    await waitFor(() => {
      expect(screen.getByTestId('onboarding')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('onboarding-dismiss'));

    expect(screen.queryByTestId('onboarding')).toBeNull();
  });

  it('does not flash when the profile cannot be read', async () => {
    getMe.mockRejectedValue(new api.ApiError(0, 'Cannot reach the API'));

    await render(<Onboarding />);

    await waitFor(() => {
      expect(getMe).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('onboarding')).toBeNull();
  });
});
