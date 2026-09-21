export function hasNativeInstallEvent(
  logs: string,
  event: string,
  fields: Readonly<Record<string, string>>,
): boolean {
  const fragments = [
    event,
    ...Object.entries(fields).map(([key, value]) => `${key}=${value}`),
  ];
  return logs
    .split(/\r?\n/)
    .some((line) => fragments.every((fragment) => line.includes(fragment)));
}
