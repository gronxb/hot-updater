import type { createE2eUpdater } from "./insights";

type RemoteConfig = ReturnType<typeof createE2eUpdater>["remoteConfig"];

export function describeRemoteConfig(client: RemoteConfig): string {
  return (["e2e_message", "e2e_limit", "e2e_flag"] as const)
    .map((key) => {
      const value = client.getValue(key);
      return `${key.slice(4)}=${value.asString()}(${value.getSource()})`;
    })
    .join(" ");
}

export async function runRemoteConfigAction(
  client: RemoteConfig,
  action: "fetch" | "activate" | "fetchAndActivate",
): Promise<string> {
  try {
    if (action === "fetch") {
      await client.fetch();
      return `remote-config fetch -> ${client.lastFetchStatus}`;
    }
    const activated = await client[action]();
    return `remote-config ${action} -> ${activated}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `remote-config ${action} -> error ${message}`;
  }
}
