import { useSignIn } from '@clerk/expo';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

type Step = 'credentials' | 'code';

interface ClerkResult {
  error: { message?: string; longMessage?: string } | null;
}

/** Clerk's own wording when it gives one; it is usually the actionable part. */
function messageOf(result: ClerkResult, fallback: string): string | null {
  if (result.error === null) return null;

  return result.error.longMessage ?? result.error.message ?? fallback;
}

/**
 * Email sign-in against the configured Clerk instance.
 *
 * The instance (checked on 2026-10-08 via its /v1/environment) signs in by
 * email address with a password, or with a one-time email code. Both are
 * here. Google sign-in is enabled too but needs an OAuth redirect into a
 * development build, so it waits for Milestone 3's EAS build.
 *
 * Accounts are created on the instance's hosted sign-up page, not here — this
 * screen only signs an existing account in.
 *
 * A new device can come back `needs_client_trust` / `needs_second_factor`:
 * Clerk wants proof it is really you, by emailed code. That is the same code
 * step, reached from the password path.
 */
export function SignInScreen() {
  const { signIn, fetchStatus } = useSignIn();
  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeIsSecondFactor, setCodeIsSecondFactor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = fetchStatus === 'fetching';

  async function finishOrContinue(): Promise<void> {
    if (signIn.status === 'complete') {
      setError(messageOf(await signIn.finalize(), 'Could not start the session'));

      return;
    }

    if (signIn.status === 'needs_second_factor' || signIn.status === 'needs_client_trust') {
      const failed = messageOf(await signIn.mfa.sendEmailCode(), 'Could not send a code');

      if (failed !== null) {
        setError(failed);

        return;
      }
      setCodeIsSecondFactor(true);
      setStep('code');

      return;
    }

    setError(`Sign-in needs a step this screen does not support yet (${signIn.status}).`);
  }

  async function withPassword(): Promise<void> {
    setError(null);
    const failed = messageOf(
      await signIn.create({ identifier: email.trim(), password }),
      'Sign-in failed',
    );

    if (failed !== null) {
      setError(failed);

      return;
    }

    await finishOrContinue();
  }

  async function sendEmailCode(): Promise<void> {
    setError(null);
    let failed = messageOf(await signIn.create({ identifier: email.trim() }), 'Sign-in failed');

    if (failed === null) {
      failed = messageOf(await signIn.emailCode.sendCode(), 'Could not send a code');
    }

    if (failed !== null) {
      setError(failed);

      return;
    }

    setCodeIsSecondFactor(false);
    setStep('code');
  }

  async function verifyCode(): Promise<void> {
    setError(null);
    const result = codeIsSecondFactor
      ? await signIn.mfa.verifyEmailCode({ code: code.trim() })
      : await signIn.emailCode.verifyCode({ code: code.trim() });
    const failed = messageOf(result, 'That code did not work');

    if (failed !== null) {
      setError(failed);

      return;
    }

    await finishOrContinue();
  }

  return (
    <View style={styles.container} testID="sign-in">
      <Text style={styles.heading}>Sign in</Text>

      {step === 'credentials' ? (
        <>
          <TextInput
            accessibilityLabel="Email address"
            autoCapitalize="none"
            autoComplete="email"
            inputMode="email"
            onChangeText={setEmail}
            placeholder="Email address"
            style={styles.input}
            value={email}
          />
          <TextInput
            accessibilityLabel="Password"
            autoComplete="current-password"
            onChangeText={setPassword}
            placeholder="Password"
            secureTextEntry
            style={styles.input}
            value={password}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || email.trim() === '' || password === ''}
            onPress={() => {
              void withPassword();
            }}
            style={styles.button}
            testID="sign-in-password"
          >
            <Text style={styles.buttonText}>{busy ? 'Signing in…' : 'Sign in'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || email.trim() === ''}
            onPress={() => {
              void sendEmailCode();
            }}
            testID="sign-in-email-code"
          >
            <Text style={styles.link}>Email me a code instead</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.body}>
            We sent a code to {email.trim()}. Enter it to finish signing in.
          </Text>
          <TextInput
            accessibilityLabel="Code from email"
            autoComplete="one-time-code"
            inputMode="numeric"
            onChangeText={setCode}
            placeholder="123456"
            style={styles.input}
            value={code}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || code.trim() === ''}
            onPress={() => {
              void verifyCode();
            }}
            style={styles.button}
            testID="sign-in-verify"
          >
            <Text style={styles.buttonText}>{busy ? 'Checking…' : 'Verify'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setStep('credentials');
              setCode('');
              setError(null);
            }}
          >
            <Text style={styles.link}>Back</Text>
          </Pressable>
        </>
      )}

      {error === null ? null : (
        <Text style={styles.error} testID="sign-in-error">
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
  heading: { fontSize: 24, fontWeight: '700' },
  body: { color: '#444', fontSize: 15, lineHeight: 22 },
  input: {
    borderColor: '#ccc',
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  button: { backgroundColor: '#7c3aed', borderRadius: 10, padding: 14 },
  buttonText: { color: '#fff', fontWeight: '600', textAlign: 'center' },
  link: { color: '#7c3aed', fontWeight: '600', paddingVertical: 6, textAlign: 'center' },
  error: { color: '#b91c1c' },
});
