/** Locale-independent lexicographic order over JavaScript UTF-16 code units. */
export const compareStringsByCodeUnit = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;
