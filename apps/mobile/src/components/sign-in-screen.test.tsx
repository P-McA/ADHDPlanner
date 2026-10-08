import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { clerkFake } from '../../test/clerk-expo-fake';
import { authHeaders, setAuthTokenProvider } from '../lib/api-client';
import { SignInGate } from './sign-in-gate';
import { SignInScreen } from './sign-in-screen';

/**
 * Our side of real sign-in: which screen the gate shows, the Clerk call
 * sequence, and the header rule. Clerk itself is `test/clerk-expo-fake.tsx`;
 * whether the API *accepts* a genuine Clerk token is checklist item 1 and is
 * proved against the live instance, not by anything in this file.
 */

const KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk';
const env = {
  key: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  dev: process.env.EXPO_PUBLIC_DEV_MODE,
};

beforeEach(() => {
  clerkFake.reset();
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = KEY;
  process.env.EXPO_PUBLIC_DEV_MODE = 'true';
});

afterEach(() => {
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = env.key;
  process.env.EXPO_PUBLIC_DEV_MODE = env.dev;
  setAuthTokenProvider(() => null);
});

const app = <Text testID="app">the app</Text>;

describe('SignInGate with a Clerk key', () => {
  it('shows sign-in, not the app, when signed out — even with dev mode on', async () => {
    // Dev mode must not be a back door once a real key is configured: a quiet
    // fallback to x-dev-user would make a real sign-in unprovable.
    await render(<SignInGate>{app}</SignInGate>);

    expect(screen.getByTestId('sign-in')).toBeTruthy();
    expect(screen.queryByTestId('app')).toBeNull();
  });

  it('shows the app, with a way to sign out, once Clerk reports a session', async () => {
    clerkFake.isSignedIn = true;

    await render(<SignInGate>{app}</SignInGate>);
    expect(screen.getByTestId('app')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('sign-out'));
    expect(clerkFake.calls).toContain('signOut');
  });

  it('waits rather than flashing sign-in while Clerk is still loading', async () => {
    clerkFake.isLoaded = false;

    await render(<SignInGate>{app}</SignInGate>);

    expect(screen.getByTestId('auth-loading')).toBeTruthy();
    expect(screen.queryByTestId('sign-in')).toBeNull();
  });
});

describe('SignInScreen', () => {
  async function fill(email: string, password?: string) {
    await fireEvent.changeText(screen.getByLabelText('Email address'), email);
    if (password !== undefined) {
      await fireEvent.changeText(screen.getByLabelText('Password'), password);
    }
  }

  it('signs in with email and password, then starts the session', async () => {
    await render(<SignInScreen />);
    await fill('  me@example.com ', 'hunter2');

    await fireEvent.press(screen.getByTestId('sign-in-password'));

    await waitFor(() => {
      expect(clerkFake.calls).toEqual(['create:me@example.com:pw', 'finalize']);
    });
  });

  it('asks for an emailed code when Clerk does not trust a new device yet', async () => {
    clerkFake.statusAfterCreate = 'needs_client_trust';
    await render(<SignInScreen />);
    await fill('me@example.com', 'hunter2');

    await fireEvent.press(screen.getByTestId('sign-in-password'));
    await waitFor(() => screen.getByLabelText('Code from email'));
    await fireEvent.changeText(screen.getByLabelText('Code from email'), ' 424242 ');
    await fireEvent.press(screen.getByTestId('sign-in-verify'));

    await waitFor(() => {
      expect(clerkFake.calls).toEqual([
        'create:me@example.com:pw',
        'mfa.sendEmailCode',
        'mfa.verifyEmailCode:424242',
        'finalize',
      ]);
    });
  });

  it('signs in with an emailed code instead of a password', async () => {
    await render(<SignInScreen />);
    await fill('me@example.com');

    await fireEvent.press(screen.getByTestId('sign-in-email-code'));
    await waitFor(() => screen.getByLabelText('Code from email'));
    await fireEvent.changeText(screen.getByLabelText('Code from email'), '111222');
    await fireEvent.press(screen.getByTestId('sign-in-verify'));

    await waitFor(() => {
      expect(clerkFake.calls).toEqual([
        'create:me@example.com:nopw',
        'emailCode.sendCode',
        'emailCode.verifyCode:111222',
        'finalize',
      ]);
    });
  });

  it("shows Clerk's reason when sign-in is refused, and starts no session", async () => {
    clerkFake.createError = { message: 'Password is incorrect. Try again.' };
    await render(<SignInScreen />);
    await fill('me@example.com', 'wrong');

    await fireEvent.press(screen.getByTestId('sign-in-password'));

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error').props.children).toBe(
        'Password is incorrect. Try again.',
      );
    });
    expect(clerkFake.calls).not.toContain('finalize');
  });
});

describe('authHeaders — a real token replaces the dev header', () => {
  it('sends only the bearer token once there is a session, even with dev mode on', async () => {
    // The API guard checks x-dev-user *first*; sending both would sign this
    // request in as the dev user and the real token would prove nothing.
    setAuthTokenProvider(() => Promise.resolve('real-session-token'));

    await expect(authHeaders()).resolves.toEqual({ authorization: 'Bearer real-session-token' });
  });

  it('falls back to the dev header only when there is no token', async () => {
    setAuthTokenProvider(() => null);

    await expect(authHeaders()).resolves.toEqual({ 'x-dev-user': 'dev' });
  });
});
