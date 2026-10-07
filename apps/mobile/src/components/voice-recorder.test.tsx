import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { audioFake } from '../../test/expo-audio-fake';
import type * as ApiClientModule from '../lib/api-client';
import * as api from '../lib/api-client';
import { formatElapsed, VoiceRecorder } from './voice-recorder';

type ApiClient = typeof ApiClientModule;

/**
 * Our side of recording: permission, call order, and what reaches
 * `uploadVoiceMemo`. The microphone is `test/expo-audio-fake.ts`; whether the
 * API accepts the part is proved against a real Nest app in
 * `apps/api/test/mobile-client.e2e-spec.ts`, which runs this same client.
 */

jest.mock('../lib/api-client', () => {
  const actual = jest.requireActual<ApiClient>('../lib/api-client');

  return {
    ...actual,
    uploadVoiceMemo: jest.fn(),
    getIngestionRecord: jest.fn(),
    listDrafts: jest.fn(),
  };
});

const uploadVoiceMemo = api.uploadVoiceMemo as jest.MockedFunction<typeof api.uploadVoiceMemo>;
const getIngestionRecord = api.getIngestionRecord as jest.MockedFunction<
  typeof api.getIngestionRecord
>;
const listDrafts = api.listDrafts as jest.MockedFunction<typeof api.listDrafts>;

async function pressRecord(): Promise<void> {
  await fireEvent.press(screen.getByTestId('record-memo'));
}

beforeEach(() => {
  audioFake.reset();
  uploadVoiceMemo.mockReset();
  uploadVoiceMemo.mockResolvedValue({ id: 'r1', status: 'uploaded' });
  // The worker has already finished by the first poll: one suggestion made.
  getIngestionRecord.mockReset();
  getIngestionRecord.mockResolvedValue({
    id: 'r1',
    status: 'draft_created',
    transcript: 'Go to the shop and get some food.',
    error: null,
  } as Awaited<ReturnType<typeof api.getIngestionRecord>>);
  listDrafts.mockReset();
  listDrafts.mockResolvedValue({
    items: [{ id: 't1', ingestionRecordId: 'r1' }],
    total: 1,
    limit: 25,
    offset: 0,
  } as unknown as Awaited<ReturnType<typeof api.listDrafts>>);
});

describe('VoiceRecorder', () => {
  it('asks for the microphone before recording, and records once allowed', async () => {
    await render(<VoiceRecorder onUploaded={jest.fn()} />);

    await pressRecord();

    await waitFor(() => {
      expect(screen.getByText(/Stop and send/)).toBeTruthy();
    });
    expect(audioFake.calls).toEqual(['permission', 'mode:true', 'prepare', 'record']);
  });

  it('says how to fix it when the microphone is refused, and records nothing', async () => {
    audioFake.permissionGranted = false;
    await render(<VoiceRecorder onUploaded={jest.fn()} />);

    await pressRecord();

    await waitFor(() => {
      expect(screen.getByTestId('record-message').props.children).toMatch(
        /Microphone access is off/,
      );
    });
    expect(audioFake.calls).toEqual(['permission']);
    expect(uploadVoiceMemo).not.toHaveBeenCalled();
  });

  it('sends the recording as an m4a on a phone, named and typed to match', async () => {
    const onUploaded = jest.fn();
    await render(<VoiceRecorder onUploaded={onUploaded} />);

    await pressRecord();
    await waitFor(() => screen.getByText(/Stop and send/));
    await pressRecord();

    await waitFor(() => {
      expect(uploadVoiceMemo).toHaveBeenCalledTimes(1);
    });

    const [part, name] = uploadVoiceMemo.mock.calls[0] ?? [];
    // Native: the {uri,name,type} shape React Native's FormData reads off disk.
    expect(part).toEqual({
      uri: 'file:///cache/Audio/recording-1.m4a',
      name,
      type: 'audio/mp4',
    });
    expect(name).toMatch(/^voice-note-.*\.m4a$/);
    expect(audioFake.calls.slice(-2)).toEqual(['stop', 'mode:false']);
    // The bug the user hit: "Queued" and then nothing. The screen must end on
    // what was heard and what it made, and refresh once that is true.
    await waitFor(() => {
      expect(screen.getByTestId('record-message').props.children).toBe(
        'Heard “Go to the shop and get some food.” — 1 suggestion added below. Approve to make it a task.',
      );
    });
    expect(getIngestionRecord).toHaveBeenCalledWith('r1');
    // Once on upload, once when the memo settled — the second is the one that
    // was missing.
    expect(onUploaded).toHaveBeenCalledTimes(2);
  });

  it('shows the real reason when sending fails, not a bare "Upload failed"', async () => {
    uploadVoiceMemo.mockRejectedValue(new TypeError('parameter 2 is not of type Blob'));
    await render(<VoiceRecorder onUploaded={jest.fn()} />);

    await pressRecord();
    await waitFor(() => screen.getByText(/Stop and send/));
    await pressRecord();

    await waitFor(() => {
      expect(screen.getByTestId('record-message').props.children).toBe(
        'Upload failed: parameter 2 is not of type Blob',
      );
    });
  });

  it('reports a recorder that could not start instead of pretending to record', async () => {
    audioFake.prepareError = new Error('audio session busy');
    await render(<VoiceRecorder onUploaded={jest.fn()} />);

    await pressRecord();

    await waitFor(() => {
      expect(screen.getByTestId('record-message').props.children).toBe(
        'Could not start recording: audio session busy',
      );
    });
    expect(screen.getByText('Record a voice note')).toBeTruthy();
  });
});

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [61_000, '1:01'],
    [600_000, '10:00'],
  ])('shows %i ms as %s', (millis, expected) => {
    expect(formatElapsed(millis)).toBe(expected);
  });
});
