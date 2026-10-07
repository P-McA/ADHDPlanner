import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { uploadVoiceMemo } from '../lib/api-client';
import { recordingFileName, recordingMimeType, toUploadPart } from '../lib/audio-part';
import { uploadErrorMessage } from './memo-upload';

type Phase = 'idle' | 'starting' | 'recording' | 'uploading';

/** `m:ss` for the running timer. */
export function formatElapsed(millis: number): string {
  const total = Math.max(0, Math.floor(millis / 1000));

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Records a voice note in the app and hands it to the same pipeline as an
 * uploaded file.
 *
 * Stop *is* send. For this audience a separate "review your recording" step is
 * one more decision between having the thought and getting it out of their
 * head, and nothing irreversible happens on send: the memo becomes AI-drafted
 * suggestions that still need approving before they are tasks. The human
 * check lives at the draft, where it already is — not here.
 *
 * `HIGH_QUALITY` writes AAC in an `.m4a` on iOS and Android and webm on web;
 * {@link recordingMimeType} reads which one it got from the URI, so the API and
 * the transcriber are told the truth about the container.
 */
export function VoiceRecorder({ onUploaded }: { onUploaded: () => void }) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const status = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setMessage(null);
    setPhase('starting');

    try {
      const permission = await requestRecordingPermissionsAsync();

      if (!permission.granted) {
        setMessage('Microphone access is off. Turn it on in settings to record a note.');
        setPhase('idle');

        return;
      }

      // iOS will not record without allowsRecording, and records silence with
      // the ringer switch on unless playsInSilentMode is set too.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setPhase('recording');
    } catch (error) {
      setMessage(
        `Could not start recording: ${error instanceof Error ? error.message : String(error)}`,
      );
      setPhase('idle');
    }
  }

  async function stopAndSend() {
    setPhase('uploading');

    try {
      await recorder.stop();
      // Release the session so other audio (and the silent switch) behaves
      // normally again once we are done.
      await setAudioModeAsync({ allowsRecording: false });

      const uri = recorder.uri;

      if (uri === null) throw new Error('the recorder produced no file');

      const type = recordingMimeType(uri);
      const name = recordingFileName(type);
      const accepted = await uploadVoiceMemo(await toUploadPart({ uri, name, type }), name);

      // Queued, not finished — same wording as the upload button, for the
      // same reason: drafts appear later, in Suggestions.
      setMessage(`Queued — ${accepted.status}. Suggestions will appear below to approve.`);
      onUploaded();
    } catch (error) {
      setMessage(uploadErrorMessage(error));
    } finally {
      setPhase('idle');
    }
  }

  const recording = phase === 'recording';
  const busy = phase === 'starting' || phase === 'uploading';
  const label =
    phase === 'starting'
      ? 'Starting…'
      : phase === 'uploading'
        ? 'Sending…'
        : recording
          ? `Stop and send · ${formatElapsed(status.durationMillis)}`
          : 'Record a voice note';

  return (
    <View>
      <Pressable
        accessibilityLabel={recording ? 'Stop recording and send' : 'Record a voice note'}
        accessibilityRole="button"
        accessibilityState={{ busy }}
        disabled={busy}
        onPress={() => {
          void (recording ? stopAndSend() : start());
        }}
        style={[styles.button, recording ? styles.recording : null]}
        testID="record-memo"
      >
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>

      {message === null ? null : (
        <Text style={styles.message} testID="record-message">
          {message}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  button: { backgroundColor: '#0f766e', borderRadius: 10, padding: 14 },
  recording: { backgroundColor: '#b91c1c' },
  buttonText: { color: '#fff', fontWeight: '600', textAlign: 'center' },
  message: { color: '#444', paddingTop: 8 },
});
