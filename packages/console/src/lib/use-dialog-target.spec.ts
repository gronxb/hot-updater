// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useDialogTarget, useOpenSession } from "./use-dialog-target";

describe("useDialogTarget", () => {
  it("keeps the last target while the dialog closes, and takes a new one", () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: { name: string } | null }) =>
        useDialogTarget(target),
      { initialProps: { target: null as { name: string } | null } },
    );
    expect(result.current).toBeNull();

    const first = { name: "QA" };
    rerender({ target: first });
    expect(result.current).toBe(first);
    rerender({ target: null });
    expect(result.current).toBe(first);

    const second = { name: "Beta" };
    rerender({ target: second });
    expect(result.current).toBe(second);
  });
});

describe("useOpenSession", () => {
  it("changes on each opening, not on closing", () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useOpenSession(open),
      { initialProps: { open: false } },
    );
    const closed = result.current;
    rerender({ open: true });
    const firstOpen = result.current;
    expect(firstOpen).not.toBe(closed);
    rerender({ open: false });
    expect(result.current).toBe(firstOpen);
    rerender({ open: true });
    expect(result.current).not.toBe(firstOpen);
  });
});
