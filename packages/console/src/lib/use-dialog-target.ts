import { useState } from "react";

/**
 * What a dialog opened for, kept while it animates closed. Closing clears
 * the target at once, and without the kept one the dialog would empty or
 * switch to another state, such as "Delete ?", during its exit animation.
 */
export function useDialogTarget<T>(target: T | null): T | null {
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) setShown(target);
  return target ?? shown;
}

/**
 * A number that changes each time `open` turns true, to key a dialog's form
 * so every opening starts from its props, even one that comes before the
 * last close finished animating.
 */
export function useOpenSession(open: boolean): number {
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession(session + 1);
  }
  return session;
}
