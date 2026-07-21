import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type { AppCheck, AppCheckTokenResult } from '@react-native-firebase/app-check';

type AppCheckClient = {
  appCheck: AppCheck;
  getToken: (appCheck: AppCheck, forceRefresh?: boolean) => Promise<AppCheckTokenResult>;
};

let clientPromise: Promise<AppCheckClient> | null = null;

function isEnabled() {
  return (
    process.env.EXPO_PUBLIC_APP_CHECK_ENABLED === 'true' &&
    Platform.OS !== 'web' &&
    Constants.appOwnership !== 'expo'
  );
}

async function initializeClient(): Promise<AppCheckClient> {
  const [{ getApp }, appCheckModule] = await Promise.all([
    import('@react-native-firebase/app'),
    import('@react-native-firebase/app-check'),
  ]);
  const provider = new appCheckModule.ReactNativeFirebaseAppCheckProvider();
  provider.configure({
    android: { provider: __DEV__ ? 'debug' : 'playIntegrity' },
    apple: { provider: __DEV__ ? 'debug' : 'appAttestWithDeviceCheckFallback' },
  });
  const appCheck = await appCheckModule.initializeAppCheck(getApp(), {
    provider,
    isTokenAutoRefreshEnabled: true,
  });
  return { appCheck, getToken: appCheckModule.getToken };
}

/** Return the current native App Check token when production enforcement is enabled. */
export async function getAppCheckToken(): Promise<string | null> {
  if (!isEnabled()) {
    return null;
  }
  const initialization = (clientPromise ??= initializeClient());
  try {
    const client = await initialization;
    const result = await client.getToken(client.appCheck);
    return result.token || null;
  } catch (error) {
    if (clientPromise === initialization) {
      clientPromise = null;
    }
    throw error;
  }
}
