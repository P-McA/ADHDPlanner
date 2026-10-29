import type { IngestionAccepted } from '@adhd/shared';
import type * as ImagePickerModule from 'expo-image-picker';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type * as ApiClientModule from '../lib/api-client';
import * as api from '../lib/api-client';
import { PhotoCapture } from './photo-capture';

type ApiClient = typeof ApiClientModule;

jest.mock('../lib/api-client', () => {
  const actual = jest.requireActual<ApiClient>('../lib/api-client');

  return { ...actual, uploadImageMemo: jest.fn() };
});

jest.mock('../lib/audio-part', () => ({
  toUploadPart: jest.fn((part: unknown) => Promise.resolve(part)),
}));

jest.mock('./memo-upload', () => ({
  reportProgress: jest.fn(() => Promise.resolve()),
  uploadErrorMessage: jest.fn((error: unknown) =>
    error instanceof Error ? error.message : 'Upload failed',
  ),
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

const Picker = jest.requireMock<typeof ImagePickerModule>('expo-image-picker');
const requestCameraPermissionsAsync = Picker.requestCameraPermissionsAsync as jest.MockedFunction<
  typeof Picker.requestCameraPermissionsAsync
>;
const launchCameraAsync = Picker.launchCameraAsync as jest.MockedFunction<
  typeof Picker.launchCameraAsync
>;
const uploadImageMemo = api.uploadImageMemo as jest.MockedFunction<typeof api.uploadImageMemo>;

const accepted: IngestionAccepted = { id: 'i1', status: 'uploaded' };

beforeEach(() => {
  jest.clearAllMocks();
  requestCameraPermissionsAsync.mockResolvedValue({ granted: true } as never);
  launchCameraAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg' }],
  } as never);
  uploadImageMemo.mockResolvedValue(accepted);
});

describe('PhotoCapture', () => {
  it('sends the photo through the image route and follows it', async () => {
    const onUploaded = jest.fn();
    await render(<PhotoCapture onUploaded={onUploaded} />);

    await fireEvent.press(screen.getByTestId('capture-photo'));

    await waitFor(() => {
      expect(uploadImageMemo).toHaveBeenCalled();
    });
    expect(uploadImageMemo.mock.calls[0]![1]).toBe('photo.jpg');
  });

  it('says so and sends nothing when camera permission is refused', async () => {
    requestCameraPermissionsAsync.mockResolvedValue({ granted: false } as never);
    await render(<PhotoCapture onUploaded={jest.fn()} />);

    await fireEvent.press(screen.getByTestId('capture-photo'));

    await waitFor(() => {
      expect(screen.getByTestId('photo-message')).toHaveTextContent(/Camera access is off/);
    });
    expect(uploadImageMemo).not.toHaveBeenCalled();
  });

  it('sends nothing when the picker is cancelled', async () => {
    launchCameraAsync.mockResolvedValue({ canceled: true, assets: null } as never);
    await render(<PhotoCapture onUploaded={jest.fn()} />);

    await fireEvent.press(screen.getByTestId('capture-photo'));

    await waitFor(() => {
      expect(launchCameraAsync).toHaveBeenCalled();
    });
    expect(uploadImageMemo).not.toHaveBeenCalled();
  });

  it('shows the API’s reason when the upload is refused', async () => {
    uploadImageMemo.mockRejectedValue(new api.ApiError(400, 'Unsupported content type'));
    await render(<PhotoCapture onUploaded={jest.fn()} />);

    await fireEvent.press(screen.getByTestId('capture-photo'));

    await waitFor(() => {
      expect(screen.getByTestId('photo-message')).toHaveTextContent(/Unsupported content type/);
    });
  });
});
