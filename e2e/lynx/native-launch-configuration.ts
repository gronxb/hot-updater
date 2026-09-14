export const HOT_UPDATER_LYNX_ANDROID_LAUNCH_CONFIGURATION_EXTRA =
  "hotUpdaterLaunchConfiguration";
export const HOT_UPDATER_LYNX_IOS_LAUNCH_CONFIGURATION_PREFIX =
  "--hot-updater-launch-configuration=";

export type LynxNativeLaunchConfiguration = Readonly<Record<string, string>>;

function absoluteHttpUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return url.toString().replace(/\/$/, "");
}

export function createLynxNativeLaunchConfiguration(options: {
  readonly appBaseURL: string;
  readonly channel?: string;
  readonly launchGeneration?: string;
  readonly runtimeConfigURL?: string;
}): LynxNativeLaunchConfiguration {
  return {
    appBaseURL: absoluteHttpUrl(options.appBaseURL, "appBaseURL"),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.launchGeneration
      ? { launchGeneration: options.launchGeneration }
      : {}),
    ...(options.runtimeConfigURL
      ? {
          runtimeConfigURL: absoluteHttpUrl(
            options.runtimeConfigURL,
            "runtimeConfigURL",
          ),
        }
      : {}),
  };
}

export function serializeLynxNativeLaunchConfiguration(
  configuration: LynxNativeLaunchConfiguration,
): string {
  return JSON.stringify(configuration);
}
