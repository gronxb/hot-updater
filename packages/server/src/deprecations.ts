const warned = new Set<string>();

/** Prints a deprecation once per process. */
export const warnDeprecated = (message: string): void => {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[hot-updater] ${message}`);
};

/** Test-only: lets a later case see the same warning again. */
export const resetDeprecationWarnings = (): void => {
  warned.clear();
};
