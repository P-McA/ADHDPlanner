import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { ApiError, uploadVoiceMemo } from '../lib/api-client';

/**
 * Sends a voice memo from the phone.
 *
 * `expo-document-picker` rather than a recorder, deliberately. What this
 * milestone is for is the first real-client exercise of the multipart
 * contract; a recorder would add microphone permissions, a native audio
 * session and a per-platform container format (m4a on iOS, not the webm the
 * browser produces) — real work, none of which is the contract. Picking a file
 * the phone already holds hits exactly the same endpoint with exactly the same
 * body. Recording is a later UX layer over this call, not a different one.
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
      const accepted = await uploadVoiceMemo(
        { uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'audio/webm' },
        asset.name,
      );

      // 202: queued, not finished. Saying "uploaded" would promise drafts that
      // do not exist yet, and the user would go looking for them.
      setMessage(`Queued — ${accepted.status}`);
      onUploaded();
    } catch (error) {
      // The API's own message, not a generic one: it is the half of the
      // multipart contract that tells a caller what went wrong (which field it
      // wanted, which content type, how many bytes).
      setMessage(error instanceof ApiError ? error.message : 'Upload failed');
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
