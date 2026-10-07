/**
 * A record's own entry. Parameter keys and condition names come from users,
 * so `constructor` or `__proto__` must name theirs, never Object.prototype's.
 */
export const ownEntry = <T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined =>
  record !== undefined && Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
