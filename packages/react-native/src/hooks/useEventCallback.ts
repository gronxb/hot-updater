import { useCallback, useLayoutEffect, useRef } from "react";

type EventCallback<Args extends unknown[], R> =
  | ((...args: Args) => R)
  | undefined;

export function useEventCallback<Args extends unknown[], R>(
  fn: (...args: Args) => R,
): (...args: Args) => R;
export function useEventCallback<Args extends unknown[], R>(
  fn: EventCallback<Args, R>,
): EventCallback<Args, R>;
export function useEventCallback<Args extends unknown[], R>(
  fn: EventCallback<Args, R>,
): EventCallback<Args, R> {
  const callbackRef = useRef<EventCallback<Args, R>>(() => {
    throw new Error("Cannot call an event handler while rendering.");
  });

  useLayoutEffect(() => {
    callbackRef.current = fn;
  }, [fn]);

  return useCallback(
    (...args: Args) => callbackRef.current?.(...args),
    [callbackRef],
  ) as (...args: Args) => R;
}
