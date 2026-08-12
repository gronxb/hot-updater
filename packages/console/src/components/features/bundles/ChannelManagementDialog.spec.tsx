import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelManagementDialog } from "./ChannelManagementDialog";

const {
  mockApi,
  mockCreateChannel,
  mockDeleteChannel,
  mockToastError,
  mockToastInfo,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockApi: {
    channels: [] as Array<{ id: string; name: string }>,
  },
  mockCreateChannel: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
  mockDeleteChannel: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    info: mockToastInfo,
    success: mockToastSuccess,
  },
}));

vi.mock("@/lib/api", () => ({
  useChannelsQuery: () => ({
    data: mockApi.channels,
    isPending: false,
  }),
  useCreateChannelMutation: () => mockCreateChannel,
  useDeleteChannelMutation: () => mockDeleteChannel,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogAction: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    disabled,
  }: {
    children: ReactNode;
    disabled?: boolean;
  }) => <button disabled={disabled}>{children}</button>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  AlertDialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  AlertDialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

describe("ChannelManagementDialog", () => {
  beforeEach(() => {
    mockApi.channels = [];
    mockCreateChannel.isPending = false;
    mockCreateChannel.mutateAsync.mockReset();
    mockDeleteChannel.isPending = false;
    mockDeleteChannel.mutateAsync.mockReset();
    mockToastError.mockReset();
    mockToastInfo.mockReset();
    mockToastSuccess.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a channel with returnExisting conflict semantics", async () => {
    mockCreateChannel.mutateAsync.mockResolvedValue({
      row: { id: "channel-beta", name: "beta" },
      inserted: true,
    });

    render(<ChannelManagementDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Channel name"), {
      target: { value: "  beta  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockCreateChannel.mutateAsync).toHaveBeenCalledWith({
        row: { id: expect.any(String), name: "beta" },
        onConflict: "returnExisting",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Channel beta created");
    expect(
      (screen.getByLabelText("Channel name") as HTMLInputElement).value,
    ).toBe("");
  });

  it("deletes an empty channel after confirmation", async () => {
    mockApi.channels = [{ id: "channel-beta", name: "beta" }];
    mockDeleteChannel.mutateAsync.mockResolvedValue({ deleted: true });

    render(<ChannelManagementDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete beta" }));
    expect(screen.getByText(/Only empty channels can be removed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));

    await waitFor(() => {
      expect(mockDeleteChannel.mutateAsync).toHaveBeenCalledWith({
        id: "channel-beta",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Channel beta deleted");
  });

  it("reports the authoritative not-empty delete result", async () => {
    mockApi.channels = [{ id: "channel-beta", name: "beta" }];
    mockDeleteChannel.mutateAsync.mockResolvedValue({
      deleted: false,
      reason: "not_empty",
    });

    render(<ChannelManagementDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Channel beta now contains bundles and cannot be deleted",
      );
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
