import type { DatabaseResourceWindow } from "./types";

export const shouldRememberReadSnapshot = <TValue>(
  data: readonly TValue[],
  window: DatabaseResourceWindow,
): boolean =>
  !(
    window.limit > 0 &&
    data.length < window.limit &&
    (data.length > 0 || window.offset === 0)
  );

export const createOneShotReadSnapshot = <TValue>() => {
  let snapshot: readonly TValue[] | undefined;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }
    snapshot = undefined;
  };

  const remember = (values: readonly TValue[]) => {
    if (clearTimer) {
      clearTimeout(clearTimer);
    }
    snapshot = values;
    clearTimer = setTimeout(() => {
      if (snapshot === values) {
        snapshot = undefined;
      }
      clearTimer = undefined;
    }, 0);
  };

  const take = () => {
    const values = snapshot;
    clear();
    return values;
  };

  return { clear, remember, take };
};
