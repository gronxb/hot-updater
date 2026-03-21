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
import { PromoteChannelDialog } from "./PromoteChannelDialog";

const {
  mockSetBundleId,
  mockCreateUUIDv7,
  mockPromoteBundleMutation,
  mockToastSuccess,
  mockToastError,
} = vi.hoisted(() => ({
  mockSetBundleId: vi.fn(),
  mockCreateUUIDv7: vi.fn(),
  mockPromoteBundleMutation: {
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

vi.mock("@/hooks/useFilterParams", () => ({
  useFilterParams: () => ({
    setBundleId: mockSetBundleId,
  }),
}));

vi.mock("@/lib/extract-timestamp-from-uuidv7", () => ({
  createUUIDv7: mockCreateUUIDv7,
}));

vi.mock("@/lib/api", () => ({
  useChannelsQuery: () => ({ data: ["stable", "beta"] }),
  usePromoteBundleMutation: () => mockPromoteBundleMutation,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/select", async () => {
  const React = await import("react");

  const SelectItem = ({ children }: { value: string; children: ReactNode }) => (
    <>{children}</>
  );

  const extractItems = (children: ReactNode) => {
    const items: Array<{ value: string; label: ReactNode }> = [];

    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) {
        return;
      }

      const element = child as React.ReactElement<{
        children?: ReactNode;
        value?: string;
      }>;

      if (element.type === SelectItem) {
        items.push({
          value: element.props.value as string,
          label: element.props.children,
        });
        return;
      }

      if (element.props.children) {
        items.push(...extractItems(element.props.children));
      }
    });

    return items;
  };

  return {
    Select: ({
      value = "",
      onValueChange,
      children,
    }: {
      value?: string;
      onValueChange?: (value: string) => void;
      children: ReactNode;
    }) => {
      const items = extractItems(children);

      return (
        <select
          aria-label="mock-select"
          value={value}
          onChange={(event) => onValueChange?.(event.target.value)}
        >
          <option value="">Select</option>
          {items.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      );
    },
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem,
    SelectTrigger: () => null,
    SelectValue: () => null,
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
  rolloutPercentage: 100,
  targetDeviceIds: [],
};

describe("PromoteChannelDialog", () => {
  const mockOnSuccess = vi.fn();
  const copiedBundleId = "0195a409-0111-7654-8abc-def012345678";

  beforeEach(() => {
    mockCreateUUIDv7.mockReset();
    mockCreateUUIDv7.mockReturnValue(copiedBundleId);
    mockSetBundleId.mockReset();
    mockPromoteBundleMutation.isPending = false;
    mockPromoteBundleMutation.mutateAsync.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockOnSuccess.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the copied bundle detail and adds a toast action with the new bundleId", async () => {
    mockPromoteBundleMutation.mutateAsync.mockResolvedValue({
      bundle: {
        ...bundle,
        id: "bundle-copy-id",
        channel: "beta",
      },
    });

    render(
      <PromoteChannelDialog
        bundle={bundle}
        open
        onOpenChange={() => {}}
        onSuccess={mockOnSuccess}
      />,
    );

    const [actionSelect] = screen.getAllByRole("combobox");
    const targetChannelInput = screen.getByLabelText("Target Channel");

    fireEvent.change(actionSelect, { target: { value: "copy" } });
    expect(screen.getByText(copiedBundleId)).toBeTruthy();
    fireEvent.change(targetChannelInput, { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(mockPromoteBundleMutation.mutateAsync).toHaveBeenCalledWith({
        action: "copy",
        bundleId: bundle.id,
        nextBundleId: copiedBundleId,
        targetChannel: "beta",
      });
    });

    expect(mockSetBundleId).not.toHaveBeenCalled();
    expect(mockOnSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith("Bundle copied to beta", {
      description: "bundleId: bundle-copy-id",
      action: expect.objectContaining({
        label: "Show Detail",
        onClick: expect.any(Function),
      }),
    });

    const toastAction = mockToastSuccess.mock.calls[0]?.[1]?.action;
    toastAction.onClick();

    expect(mockSetBundleId).toHaveBeenCalledTimes(1);
    expect(mockSetBundleId).toHaveBeenCalledWith("bundle-copy-id", {
      channel: "beta",
      offset: "0",
    });
  });

  it("opens the moved bundle detail with the same bundleId", async () => {
    mockPromoteBundleMutation.mutateAsync.mockResolvedValue({
      bundle: {
        ...bundle,
        channel: "beta",
      },
    });

    render(
      <PromoteChannelDialog
        bundle={bundle}
        open
        onOpenChange={() => {}}
        onSuccess={mockOnSuccess}
      />,
    );

    fireEvent.change(screen.getByLabelText("Target Channel"), {
      target: { value: "beta" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => {
      expect(mockPromoteBundleMutation.mutateAsync).toHaveBeenCalledWith({
        action: "move",
        bundleId: bundle.id,
        targetChannel: "beta",
      });
    });

    expect(mockSetBundleId).not.toHaveBeenCalled();
    expect(mockOnSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith("Bundle moved to beta", {
      description: `bundleId: ${bundle.id}`,
      action: expect.objectContaining({
        label: "Show Detail",
        onClick: expect.any(Function),
      }),
    });
  });

  it("allows promoting to a brand-new channel that is not in the channel list", async () => {
    mockPromoteBundleMutation.mutateAsync.mockResolvedValue({
      bundle: {
        ...bundle,
        channel: "nightly",
      },
    });

    render(
      <PromoteChannelDialog
        bundle={bundle}
        open
        onOpenChange={() => {}}
        onSuccess={mockOnSuccess}
      />,
    );

    fireEvent.change(screen.getByLabelText("Target Channel"), {
      target: { value: "nightly" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => {
      expect(mockPromoteBundleMutation.mutateAsync).toHaveBeenCalledWith({
        action: "move",
        bundleId: bundle.id,
        targetChannel: "nightly",
      });
    });

    expect(mockSetBundleId).not.toHaveBeenCalled();
    expect(mockOnSuccess).toHaveBeenCalledTimes(1);
  });

  it("shows the backend error message when promotion fails", async () => {
    mockPromoteBundleMutation.mutateAsync.mockRejectedValue(
      new Error("Legacy bundle without manifest.json"),
    );

    render(
      <PromoteChannelDialog
        bundle={bundle}
        open
        onOpenChange={() => {}}
        onSuccess={mockOnSuccess}
      />,
    );

    const [actionSelect] = screen.getAllByRole("combobox");
    fireEvent.change(actionSelect, { target: { value: "copy" } });
    fireEvent.change(screen.getByLabelText("Target Channel"), {
      target: { value: "beta" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Legacy bundle without manifest.json",
      );
    });
  });
});
