import { useSyncExternalStore } from "react";

import { e2eRemoteConfig } from "./runtime";

const REMOTE_CONFIG_KEYS = ["e2e_message", "e2e_limit", "e2e_flag"] as const;

/** Each parameter's value and where it came from, as one line. */
const describeRemoteConfig = (
  values: ReturnType<typeof e2eRemoteConfig.getAll>,
) =>
  REMOTE_CONFIG_KEYS.map((key) => {
    const value = values[key] ?? e2eRemoteConfig.getValue(key);
    return `${key.slice(4)}=${value.asString()}(${value.getSource()})`;
  }).join(" ");

/** The Remote Config the app reads, and its fetch, activate, and fetchAndActivate actions. */
export const useRemoteConfigActions = ({
  setUpdateActionResult,
}: {
  readonly setUpdateActionResult: (result: string) => Promise<void>;
}) => {
  const values = useSyncExternalStore(
    e2eRemoteConfig.subscribe,
    e2eRemoteConfig.getAll,
  );

  const fetchRemoteConfig = async () => {
    try {
      await e2eRemoteConfig.fetch();
      await setUpdateActionResult(
        `remote-config fetch -> ${e2eRemoteConfig.lastFetchStatus}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setUpdateActionResult(`remote-config fetch -> error ${message}`);
    }
  };

  const activateRemoteConfig = async () => {
    try {
      const activated = await e2eRemoteConfig.activate();
      await setUpdateActionResult(`remote-config activate -> ${activated}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setUpdateActionResult(`remote-config activate -> error ${message}`);
    }
  };

  const fetchAndActivateRemoteConfig = async () => {
    try {
      const activated = await e2eRemoteConfig.fetchAndActivate();
      await setUpdateActionResult(
        `remote-config fetchAndActivate -> ${activated}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setUpdateActionResult(
        `remote-config fetchAndActivate -> error ${message}`,
      );
    }
  };

  return {
    activateRemoteConfig,
    fetchAndActivateRemoteConfig,
    fetchRemoteConfig,
    remoteConfigText: describeRemoteConfig(values),
  };
};
