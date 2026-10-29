import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { registerPushToken } from '../lib/api-client';

/**
 * Registers this device for reminders, once, on launch.
 *
 * Renders nothing. The API already knows how to sweep and dedupe; what it has
 * never had is a real token, because nothing on the phone ever asked. This is
 * that missing half.
 *
 * Deliberately quiet: a refusal, a simulator, or a missing EAS project id all
 * mean "no reminders", not an error the user can act on while looking at their
 * task list. The next launch tries again.
 *
 * Web is skipped: Expo web has no push token, and asking there would only
 * produce a permission prompt the browser cannot honour.
 */
export function PushRegistrar() {
  useEffect(() => {
    if (Platform.OS === 'web') return;

    let cancelled = false;

    const register = async (): Promise<void> => {
      // A simulator has no push token; asking is a guaranteed failure.
      if (!Device.isDevice) return;

      if (Platform.OS === 'android') {
        // Android 8+ drops notifications with no channel. `default` is what
        // the API's payload names.
        await Notifications.setNotificationChannelAsync('default', {
          name: 'Reminders',
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      }

      const existing = await Notifications.getPermissionsAsync();
      const permission =
        existing.status === Notifications.PermissionStatus.GRANTED
          ? existing
          : await Notifications.requestPermissionsAsync();

      if (permission.status !== Notifications.PermissionStatus.GRANTED || cancelled) return;

      // The SDK types `expoConfig` loosely; this is the one field read from it.
      const constants = Constants as {
        expoConfig?: { extra?: { eas?: { projectId?: string } } } | null;
        easConfig?: { projectId?: string } | null;
      };
      const projectId =
        constants.expoConfig?.extra?.eas?.projectId ?? constants.easConfig?.projectId;

      if (projectId === undefined) return;

      const { data } = (await Notifications.getExpoPushTokenAsync({ projectId })) as {
        data: string;
      };

      if (cancelled) return;

      await registerPushToken({ token: data });
    };

    register().catch(() => {
      // Forgotten rather than remembered: the next launch tries again.
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
