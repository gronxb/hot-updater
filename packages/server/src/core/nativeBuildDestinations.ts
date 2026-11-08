/** Store destinations accepted for each native platform. */
export const NATIVE_BUILD_SUBMISSION_DESTINATIONS = {
  android: ["play-internal", "play-closed", "play-open", "play-production"],
  ios: ["testflight"],
} as const;
