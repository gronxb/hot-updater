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

import { DeleteBundleDialog } from "./DeleteBundleDialog";

const { mockDeleteBundleMutation, mockToastSuccess, mockToastError } =
  vi.hoisted(() => ({
    mockDeleteBundleMutation: {
      isPending: false,
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
  useDeleteBundleMutation: () => mockDeleteBundleMutation,
}));

vi.mock("@/components/ui/alert-dialog", async () => {
  const React = await import("react");

  const DialogContext = React.createContext<{
    onOpenChange?: (open: boolean) => void;
  }>({});

  return {
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange?: (open: boolean) => void;
      children: ReactNode;
    }) =>
      open ? (
        <DialogContext.Provider value={{ onOpenChange }}>
          <div>{children}</div>
        </DialogContext.Provider>
      ) : null,
    AlertDialogAction: ({
      children,
      disabled,
      onClick,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    }) => {
      const { onOpenChange } = React.useContext(DialogContext);

      return (
        <button
          disabled={disabled}
          onClick={() => {
            const event = {
              defaultPrevented: false,
              preventDefault() {
                this.defaultPrevented = true;
              },
            } as React.MouseEvent<HTMLButtonElement> & {
              defaultPrevented: boolean;
            };

            onClick?.(event);

            if (!event.defaultPrevented) {
              onOpenChange?.(false);
            }
          }}
        >
          {children}
        </button>
      );
    },
    AlertDialogCancel: ({
      children,
      disabled,
    }: {
      children: ReactNode;
      disabled?: boolean;
    }) => {
      const { onOpenChange } = React.useContext(DialogContext);

      return (
        <button disabled={disabled} onClick={() => onOpenChange?.(false)}>
          {children}
        </button>
      );
    },
    AlertDialogContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    AlertDialogDescription: ({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    ),
    AlertDialogFooter: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    AlertDialogHeader: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    AlertDialogTitle: ({ children }: { children: ReactNode }) => (
      <h2>{children}</h2>
    ),
  };
});

const bundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "stable",
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

describe("DeleteBundleDialog", () => {
  const mockOnOpenChange = vi.fn();
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    mockDeleteBundleMutation.isPending = false;
    mockDeleteBundleMutation.mutateAsync.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockOnOpenChange.mockReset();
    mockOnSuccess.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the dialog open until the delete request finishes", async () => {
    let resolveDelete: (() => void) | undefined;

    mockDeleteBundleMutation.mutateAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );

    render(
      <DeleteBundleDialog
        bundle={bundle}
        open
        onOpenChange={mockOnOpenChange}
        onSuccess={mockOnSuccess}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(mockDeleteBundleMutation.mutateAsync).toHaveBeenCalledWith({
      bundleId: bundle.id,
    });
    expect(mockOnOpenChange).not.toHaveBeenCalled();
    expect(mockOnSuccess).not.toHaveBeenCalled();

    resolveDelete?.();

    await waitFor(() => {
      expect(mockOnOpenChange).toHaveBeenCalledWith(false);
    });

    expect(mockOnSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Bundle deleted successfully",
    );
  });

  it("ignores cancel requests while deletion is pending", () => {
    mockDeleteBundleMutation.isPending = true;

    render(
      <DeleteBundleDialog
        bundle={bundle}
        open
        onOpenChange={mockOnOpenChange}
        onSuccess={mockOnSuccess}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockOnOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
