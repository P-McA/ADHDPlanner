import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { uploadImageMemo } from '../lib/api-client';
import { toUploadPart } from '../lib/audio-part';
import { reportProgress, uploadErrorMessage } from './memo-upload';
import { space, TAP, type ThemeColors, type as typeScale, useTheme } from '../theme/theme';

type Source = 'camera' | 'library';

/**
 * Photograph a whiteboard, notebook page or sticky note.
 *
 * The same fence as voice: 202, then drafts the user approves. The camera is
 * the point — a list on a wall is exactly the thing this app exists to take
 * off the user's hands — but the library is offered too, because a screenshot
 * or a photo taken earlier is the same job.
 *
 * A refusal keeps the screen usable and says what the API said; the picker
 * itself being cancelled is silent.
 */
export function PhotoCapture({ onUploaded }: { onUploaded: () => void }) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [busy, setBusy] = useState<Source | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function capture(source: Source) {
    setBusy(source);
    setMessage(null);

    try {
      const permission =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        setMessage(
          source === 'camera'
            ? 'Camera access is off — turn it on in Settings, or choose a photo instead.'
            : 'Photo access is off — turn it on in Settings.',
        );
        return;
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });

      if (result.canceled) return;

      const asset = result.assets[0];

      if (asset === undefined) return;

      const part = await toUploadPart({
        uri: asset.uri,
        name: asset.fileName ?? 'photo.jpg',
        type: asset.mimeType ?? 'image/jpeg',
        ...(asset.file === undefined ? {} : { file: asset.file }),
      });
      const accepted = await uploadImageMemo(part, asset.fileName ?? 'photo.jpg');

      await reportProgress(accepted.id, setMessage, onUploaded, undefined, 'Sent — reading your photo…');
    } catch (error) {
      setMessage(uploadErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          disabled={busy !== null}
          onPress={() => {
            void capture('camera');
          }}
          style={styles.button}
          testID="capture-photo"
        >
          <Ionicons name="camera-outline" size={16} color={colors.accent} />
          <Text style={styles.buttonText}>{busy === 'camera' ? 'Sending…' : 'Take a photo'}</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={busy !== null}
          onPress={() => {
            void capture('library');
          }}
          style={styles.button}
          testID="choose-photo"
        >
          <Ionicons name="images-outline" size={16} color={colors.accent} />
          <Text style={styles.buttonText}>{busy === 'library' ? 'Sending…' : 'Choose a photo'}</Text>
        </Pressable>
      </View>

      {message === null ? null : (
        <Text style={styles.message} testID="photo-message">
          {message}
        </Text>
      )}
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { gap: space.xs },
    row: { flexDirection: 'row', gap: space.sm },
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
    message: { ...typeScale.small, color: colors.textMuted, paddingTop: space.xs },
  });
}
