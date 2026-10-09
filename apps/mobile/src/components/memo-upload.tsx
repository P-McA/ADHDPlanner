import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text } from 'react-native';

import { ApiError, retryIngestion, uploadVoiceMemo } from '../lib/api-client';
import { toUploadPart } from '../lib/audio-part';
import { followMemo } from '../lib/memo-progress';
import { radius, space, TAP, type ThemeColors, type as typeScale, useTheme } from '../theme/theme';

/**
 * After a 202: say it is being listened to, wait for the worker to finish,
 * then say what it heard and refresh so any suggestion is actually on screen.
 *
 * The list is refreshed twice on purpose — once now, so the screen reflects
 * the upload, and once when the memo settles, which is the refresh that was
 * missing: before it, a suggestion made seconds after the 202 stayed invisible
 * until the user reloaded.
 */
export async function reportProgress(
  id: string,
  setMessage: (message: string) => void,
  refresh: () => void,
  setRetryId: (id: string | null) => void = () => undefined,
): Promise<void> {
  setMessage('Sent — listening to your note…');
  setRetryId(null);
  refresh();

  setMessage(
    await followMemo(id, {
      // A failed memo is offered back as a Retry, never a dead end.
      onSettled: (record) => {
        setRetryId(record.status === 'failed' ? record.id : null);
      },
    }),
  );
  refresh();
}

/**
 * Sends a failed memo through the pipeline again and follows it, exactly as
 * after an upload. Used by both the picker and the recorder, so a memo that
 * failed either way gets the same second chance.
 */
export function RetryMemoButton({
  id,
  setMessage,
  setRetryId,
  refresh,
}: {
  id: string;
  setMessage: (message: string) => void;
  setRetryId: (id: string | null) => void;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const styles = makeStyles(useTheme().colors);

  async function retry() {
    setBusy(true);

    try {
      await retryIngestion(id);
      setBusy(false);
      await reportProgress(id, setMessage, refresh, setRetryId);
    } catch (error) {
      setMessage(uploadErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={() => {
        void retry();
      }}
      style={styles.retry}
      testID="retry-memo"
    >
      <Text style={styles.retryText}>{busy ? 'Retrying…' : 'Try that note again'}</Text>
    </Pressable>
  );
}

/**
 * What to tell the user when an upload did not go through.
 *
 * The API's own message when there is one: it is the half of the multipart
 * contract that says what went wrong (which field, which content type, how many
 * bytes). Otherwise the error's message — never a bare "Upload failed". That
 * bare string is what hid the real cause last time: a TypeError thrown by the
 * browser's FormData before any request was made, indistinguishable on screen
 * from the API being down.
 */
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== '') return `Upload failed: ${error.message}`;

  return 'Upload failed';
}

/**
 * Sends a voice memo the phone already holds — the alternative to recording
 * one in the app with {@link VoiceRecorder}. Both end in the same
 * `uploadVoiceMemo` call through `toUploadPart`, so there is one multipart
 * contract and one place that knows how each platform shapes a file part.
 *
 * `copyToCacheDirectory` is on so the URI stays readable while the request is
 * in flight: a `content://` URI handed straight from the Android picker can be
 * revoked as soon as the picker closes.
 */
export function MemoUpload({ onUploaded }: { onUploaded: () => void }) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [state, setState] = useState<'idle' | 'uploading'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);

  async function pickAndUpload() {
    const picked = await DocumentPicker.getDocumentAsync({
      type: 'audio/*',
      copyToCacheDirectory: true,
      multiple: false,
    });

    if (picked.canceled) return;

    const asset = picked.assets[0];

    if (asset === undefined) return;

    setState('uploading');
    setMessage(null);

    try {
      const part = await toUploadPart({
        uri: asset.uri,
        name: asset.name,
        type: asset.mimeType ?? 'audio/webm',
        ...(asset.file === undefined ? {} : { file: asset.file }),
      });
      const accepted = await uploadVoiceMemo(part, asset.name);

      setState('idle');
      await reportProgress(accepted.id, setMessage, onUploaded, setRetryId);
    } catch (error) {
      // The API's own message, not a generic one: it is the half of the
      // multipart contract that tells a caller what went wrong (which field it
      // wanted, which content type, how many bytes).
      setMessage(uploadErrorMessage(error));
    } finally {
      setState('idle');
    }
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        disabled={state === 'uploading'}
        onPress={() => {
          void pickAndUpload();
        }}
        style={styles.button}
        testID="upload-memo"
      >
        <Ionicons name="cloud-upload-outline" size={16} color={colors.accent} />
        <Text style={styles.buttonText}>
          {state === 'uploading' ? 'Uploading…' : 'Upload a voice memo'}
        </Text>
      </Pressable>

      {message === null ? null : (
        <Text style={styles.message} testID="upload-message">
          {message}
        </Text>
      )}

      {retryId === null ? null : (
        <RetryMemoButton
          id={retryId}
          refresh={onUploaded}
          setMessage={setMessage}
          setRetryId={setRetryId}
        />
      )}
    </>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    // Secondary to recording: a quiet text button, not a second slab of colour.
    button: {
      alignItems: 'center',
      alignSelf: 'center',
      flexDirection: 'row',
      gap: space.xs,
      justifyContent: 'center',
      minHeight: TAP,
      paddingHorizontal: space.md,
    },
    buttonText: { ...typeScale.label, color: colors.accent },
    message: { ...typeScale.small, color: colors.textMuted, paddingTop: space.sm },
    retry: {
      alignSelf: 'flex-start',
      borderColor: colors.accent,
      borderRadius: radius.pill,
      borderWidth: 1,
      justifyContent: 'center',
      marginTop: space.sm,
      minHeight: TAP - 8,
      paddingHorizontal: space.lg,
    },
    retryText: { ...typeScale.label, color: colors.accent },
  });
}
