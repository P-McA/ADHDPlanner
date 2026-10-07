/**
 * Stand-in for `expo-audio` under Jest, wired in by `moduleNameMapper`.
 *
 * The real module is a native class (`AudioRecorder` extends a native shared
 * object), which does not exist in Jest's Node runtime — importing it fails
 * with `Cannot read properties of undefined (reading 'prototype')` before a
 * test runs. The microphone is a boundary we do not own, so it is faked here;
 * what the tests assert is our side of it: permission handling, the order of
 * calls, and what we send to the API afterwards.
 *
 * Programmable through `audioFake`, so a test can deny permission, make a
 * recording, or make the recorder fail.
 */

export const RecordingPresets = { HIGH_QUALITY: { extension: '.m4a' } };

export const audioFake = {
  permissionGranted: true,
  /** What `recorder.uri` reports after stop — iOS writes an .m4a in the cache. */
  uri: 'file:///cache/Audio/recording-1.m4a' as string | null,
  prepareError: null as Error | null,
  calls: [] as string[],
  reset(): void {
    this.permissionGranted = true;
    this.uri = 'file:///cache/Audio/recording-1.m4a';
    this.prepareError = null;
    this.calls.length = 0;
  },
};

const recorder = {
  get uri(): string | null {
    return audioFake.uri;
  },
  prepareToRecordAsync(): Promise<void> {
    audioFake.calls.push('prepare');

    return audioFake.prepareError === null
      ? Promise.resolve()
      : Promise.reject(audioFake.prepareError);
  },
  record(): void {
    audioFake.calls.push('record');
  },
  stop(): Promise<void> {
    audioFake.calls.push('stop');

    return Promise.resolve();
  },
};

export function useAudioRecorder(): typeof recorder {
  return recorder;
}

export function useAudioRecorderState(): { isRecording: boolean; durationMillis: number } {
  return { isRecording: false, durationMillis: 0 };
}

export function requestRecordingPermissionsAsync(): Promise<{ granted: boolean }> {
  audioFake.calls.push('permission');

  return Promise.resolve({ granted: audioFake.permissionGranted });
}

export function setAudioModeAsync(mode: { allowsRecording?: boolean }): Promise<void> {
  audioFake.calls.push(`mode:${String(mode.allowsRecording)}`);

  return Promise.resolve();
}
