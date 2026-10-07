import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { ApiError, uploadVoiceMemo } from '../lib/api-client';
import { toUploadPart } from '../lib/audio-part';
import { followMemo } from '../lib/memo-progress';

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
): Promise<void> {
  setMessage('Sent — listening to your note…');
  refresh();

  setMessage(await followMemo(id));
  refresh();
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
  const [state, setState] = useState<'idle' | 'uploading'>('idle');
  const [message, setMessage] = useState<string | null>(null);

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
      await reportProgress(accepted.id, setMessage, onUploaded);
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
        <Text style={styles.buttonText}>
          {state === 'uploading' ? 'Uploading…' : 'Upload a voice memo'}
        </Text>
      </Pressable>

      {message === null ? null : (
        <Text style={styles.message} testID="upload-message">
          {message}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  button: { backgroundColor: '#7c3aed', borderRadius: 10, padding: 14 },
  buttonText: { color: '#fff', fontWeight: '600', textAlign: 'center' },
  message: { color: '#444', paddingTop: 8 },
});
