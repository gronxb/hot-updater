import type { Bundle } from "@hot-updater/plugin-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BundleEditorSheet } from "./BundleEditorSheet";

vi.mock("./BundleAnalyticsSummary", () => ({
  BundleAnalyticsSummary: () => <div>Bundle analytics summary</div>,
}));
vi.mock("./BundleBasicInfo", () => ({
  BundleBasicInfo: () => <div>Bundle basic info</div>,
}));
vi.mock("./BundleMetadata", () => ({
  BundleMetadata: () => <div>Bundle metadata</div>,
}));
vi.mock("./DeleteBundleDialog", () => ({
  DeleteBundleDialog: ({ open }: { open: boolean }) =>
    open ? <div>Reference-safe delete confirmation</div> : null,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    children,
    onOpenChange,
    open,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
    open: boolean;
  }) =>
    open ? (
      <div>
        <button onClick={() => onOpenChange?.(false)}>Dismiss sheet</button>
        {children}
      </div>
    ) : null,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const bundle: Bundle = {
  fileHash: "abc123",
  gitCommitHash: "deadbeef",
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  platform: "ios",
  storageUri: "s3://bucket/bundle.zip",
};

describe("BundleEditorSheet", () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    onOpenChange.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps Bundle details artifact-only and exposes safe storage actions", () => {
    render(
      <BundleEditorSheet bundle={bundle} onOpenChange={onOpenChange} open />,
    );

    expect(screen.getByText("Immutable artifact")).not.toBeNull();
    expect(
      screen.getByText(/Delivery targeting, rollout, force, and enabled state/),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete Bundle" }));
    expect(
      screen.getByText("Reference-safe delete confirmation"),
    ).not.toBeNull();
  });

  it("allows the read-only sheet to close", () => {
    render(
      <BundleEditorSheet bundle={bundle} onOpenChange={onOpenChange} open />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss sheet" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
