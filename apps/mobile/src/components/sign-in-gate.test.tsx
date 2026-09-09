import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { SignInGate } from './sign-in-gate';

/**
 * The client half of the dev sign-in, and only that half.
 *
 * What this file cannot prove — that the API refuses the header when the
 * server has not armed `DEV_AUTH_BYPASS` — is proved in
 * `test/mobile-client.e2e-spec.ts`, against the real `ClerkAuthGuard`. Both
 * halves are needed and neither substitutes for the other.
 */

const original = process.env.EXPO_PUBLIC_DEV_MODE;

afterEach(() => {
  process.env.EXPO_PUBLIC_DEV_MODE = original;
});

describe('SignInGate', () => {
  it('lets the app through when dev mode is on', async () => {
    process.env.EXPO_PUBLIC_DEV_MODE = 'true';

    await render(
      <SignInGate>
        <Text testID="app">signed in</Text>
      </SignInGate>,
    );

    expect(screen.getByTestId('app')).toBeTruthy();
  });

  it('refuses to render the app without a session, rather than showing an empty one', async () => {
    process.env.EXPO_PUBLIC_DEV_MODE = 'false';

    await render(
      <SignInGate>
        <Text testID="app">signed in</Text>
      </SignInGate>,
    );

    expect(screen.queryByTestId('app')).toBeNull();
    expect(screen.getByTestId('signed-out')).toBeTruthy();
  });

  it('treats an unset flag as signed out, never as a default-on bypass', async () => {
    delete process.env.EXPO_PUBLIC_DEV_MODE;

    await render(
      <SignInGate>
        <Text testID="app">signed in</Text>
      </SignInGate>,
    );

    expect(screen.queryByTestId('app')).toBeNull();
  });
});
