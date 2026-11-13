import { Platform } from 'react-native'

// The API is served by the same Worker as the web export, so the web uses its own origin.
// A phone build is pointed at a deployment with EXPO_PUBLIC_API_URL; only a development
// build falls back to a local Worker, so a release build never quietly talks to localhost.
// (Moved here from app/_layout.tsx so the Takes screens reach the same server.)
export const apiUrl: string | null = Platform.OS === 'web' && typeof window !== 'undefined'
  ? window.location.origin
  : process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? 'http://localhost:8787' : null)
