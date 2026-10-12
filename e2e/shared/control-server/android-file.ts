import { spawnSync } from "node:child_process";

/** Read binary evidence with shell-v2 exit status and separate stderr. */
export function readAndroidFileBuffer(
  deviceId: string,
  appId: string,
  remotePath: string,
) {
  const prefix = [`/data/data/${appId}/`, `/data/user/0/${appId}/`].find(
    (candidate) => remotePath.startsWith(candidate),
  );
  const runAsPath = prefix ? remotePath.slice(prefix.length) : remotePath;
  const attempts = [
    ["run-as", appId, "cat", runAsPath],
    ["cat", remotePath],
  ];
  const errors: string[] = [];
  for (const args of attempts) {
    // exec-out merges remote stderr into stdout and can return zero for a
    // failed cat. -T keeps bytes unchanged while shell-v2 reports that failure.
    const result = spawnSync("adb", ["-s", deviceId, "shell", "-T", ...args], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!result.error && result.status === 0) {
      return { fileBuffer: result.stdout, readError: null };
    }
    errors.push(
      result.error?.message ||
        result.stderr?.toString().trim() ||
        `adb exited ${String(result.status)}`,
    );
  }
  return { fileBuffer: null, readError: errors.join(" | ") };
}
