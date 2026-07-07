import type { Bundle } from "@hot-updater/plugin-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BundleEditorSheet } from "./BundleEditorSheet";

const mockBundleEditorForm = vi.fn();

vi.mock("./BundleEditorForm", () => ({
  BundleEditorForm: (props: {
    onBusyChange?: (busy: boolean) => void;
    onClose: () => void;
  }) => {
    mockBundleEditorForm(props);

    return (
      <div>
        <button onClick={() => props.onBusyChange?.(true)}>Mark busy</button>
        <button onClick={() => props.onBusyChange?.(false)}>Mark idle</button>
        <button onClick={props.onClose}>Finish save</button>
      </div>
    );
  },
}));

vi.mock("./BundleBasicInfo", () => ({
  BundleBasicInfo: () => <div>Bundle basic info</div>,
}));

vi.mock("./BundleMetadata", () => ({
  BundleMetadata: () => <div>Bundle metadata</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
  }) =>
    open ? (
      <div>
        <button onClick={() => onOpenChange?.(false)}>Dismiss sheet</button>
        {children}
      </div>
    ) : null,
  SheetContent: ({
    children,
    showCloseButton = true,
  }: {
    children: ReactNode;
    showCloseButton?: boolean;
  }) => (
    <div>
      {showCloseButton ? <button>Sheet close</button> : null}
      {children}
    </div>
  ),
  SheetDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div>Skeleton</div>,
}));

const bundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "abc123",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
};

describe("BundleEditorSheet", () => {
  const mockOnOpenChange = vi.fn();

  beforeEach(() => {
    mockOnOpenChange.mockReset();
    mockBundleEditorForm.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("ignores dismiss requests while the editor is saving", () => {
    render(
      <BundleEditorSheet
        bundle={bundle}
        open
        onOpenChange={mockOnOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark busy" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss sheet" }));

    expect(mockOnOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sheet close" })).toBeNull();
  });

  it("allows successful saves to close the sheet even after entering a busy state", () => {
    render(
      <BundleEditorSheet
        bundle={bundle}
        open
        onOpenChange={mockOnOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark busy" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish save" }));

    expect(mockOnOpenChange).toHaveBeenCalledWith(false);
  });
});
