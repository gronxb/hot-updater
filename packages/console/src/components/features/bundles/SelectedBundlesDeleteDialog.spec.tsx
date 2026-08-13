import type { Bundle } from "@hot-updater/plugin-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SelectedBundlesDeleteDialog } from "./SelectedBundlesDeleteDialog";

const { mockDeleteBundlesMutation, mockToastSuccess, mockToastError } =
  vi.hoisted(() => ({
    mockDeleteBundlesMutation: {
      mutateAsync: vi.fn(),
    },
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
  }));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

vi.mock("@/lib/api", () => ({
  useDeleteBundlesMutation: () => mockDeleteBundlesMutation,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    readonly open: boolean;
    readonly onOpenChange?: (open: boolean) => void;
    readonly children: ReactNode;
  }) =>
    open ? (
      <dialog open>
        <button onClick={() => onOpenChange?.(false)}>Dismiss dialog</button>
        {children}
      </dialog>
    ) : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { readonly children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { readonly children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { readonly children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { readonly children: ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

function createDeferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    reject(reason?: unknown) {
      if (!rejectPromise) {
        throw new Error("Deferred reject was not initialized");
      }

      rejectPromise(reason);
    },
    resolve(value: T) {
      if (!resolvePromise) {
        throw new Error("Deferred resolve was not initialized");
      }

      resolvePromise(value);
    },
  };
}

const createBundle = (id: string, channel: string): Bundle => ({
  id,
  channel,
  platform: id.endsWith("ios") ? "ios" : "android",
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
});

describe("SelectedBundlesDeleteDialog", () => {
  const firstBundle = createBundle("bundle-001-ios", "stable");
  const secondBundle = createBundle("bundle-002-android", "beta");
  const mockOnOpenChange = vi.fn();
  const mockOnComplete = vi.fn();

  beforeEach(() => {
    mockDeleteBundlesMutation.mutateAsync.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockOnOpenChange.mockReset();
    mockOnComplete.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("deletes all selected bundles in one batch", async () => {
    const deletion = createDeferred<void>();
    mockDeleteBundlesMutation.mutateAsync.mockReturnValue(deletion.promise);

    render(
      <SelectedBundlesDeleteDialog
        bundles={[firstBundle, secondBundle]}
        open
        onOpenChange={mockOnOpenChange}
        onComplete={mockOnComplete}
      />,
    );

    expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockDeleteBundlesMutation.mutateAsync).toHaveBeenCalledWith({
        bundleIds: [firstBundle.id, secondBundle.id],
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss dialog" }));
    expect(mockOnOpenChange).not.toHaveBeenCalled();

    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Queued" })).toBeNull();
    expect(screen.getAllByLabelText("Deleting")).toHaveLength(2);

    deletion.resolve(undefined);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mockOnOpenChange).toHaveBeenCalledWith(false);

    expect(mockOnComplete).toHaveBeenCalledWith({
      deletedBundleIds: [firstBundle.id, secondBundle.id],
      failedBundleIds: [],
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "2 bundles deleted successfully",
    );
  });

  it("keeps a failed batch actionable and retries it", async () => {
    mockDeleteBundlesMutation.mutateAsync
      .mockRejectedValueOnce(new Error("storage timeout"))
      .mockResolvedValueOnce(undefined);

    render(
      <SelectedBundlesDeleteDialog
        bundles={[firstBundle, secondBundle]}
        open
        onOpenChange={mockOnOpenChange}
        onComplete={mockOnComplete}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry failed" })).toBeTruthy();
    });

    expect(screen.getAllByText("storage timeout")).toHaveLength(2);
    expect(mockOnComplete).toHaveBeenCalledWith({
      deletedBundleIds: [],
      failedBundleIds: [firstBundle.id, secondBundle.id],
    });
    expect(mockToastError).toHaveBeenCalledWith("0 deleted, 2 failed");

    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));

    await waitFor(() => {
      expect(mockDeleteBundlesMutation.mutateAsync).toHaveBeenCalledTimes(2);
    });

    expect(mockDeleteBundlesMutation.mutateAsync).toHaveBeenLastCalledWith({
      bundleIds: [firstBundle.id, secondBundle.id],
    });
    expect(mockOnComplete).toHaveBeenLastCalledWith({
      deletedBundleIds: [firstBundle.id, secondBundle.id],
      failedBundleIds: [],
    });
  });
});
