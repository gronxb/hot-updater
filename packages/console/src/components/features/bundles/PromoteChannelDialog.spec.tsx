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
  mockCreateBundleMutation,
  mockUpdateBundleMutation,
  mockToastSuccess,
  mockToastError,
  mockCreateUUIDv7WithSameTimestamp,
} = vi.hoisted(() => ({
  mockSetBundleId: vi.fn(),
  mockCreateBundleMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
  mockUpdateBundleMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockCreateUUIDv7WithSameTimestamp: vi.fn(),
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

vi.mock("@/lib/api", () => ({
  useChannelsQuery: () => ({ data: ["stable", "beta"] }),
  useCreateBundleMutation: () => mockCreateBundleMutation,
  useUpdateBundleMutation: () => mockUpdateBundleMutation,
}));

vi.mock("@/lib/extract-timestamp-from-uuidv7", () => ({
  createUUIDv7WithSameTimestamp: mockCreateUUIDv7WithSameTimestamp,
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
  rolloutCohortCount: 1000,
  targetCohorts: [],
};

describe("PromoteChannelDialog", () => {
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    mockSetBundleId.mockReset();
    mockCreateBundleMutation.isPending = false;
    mockCreateBundleMutation.mutateAsync.mockReset();
    mockUpdateBundleMutation.isPending = false;
    mockUpdateBundleMutation.mutateAsync.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockCreateUUIDv7WithSameTimestamp.mockReset();
    mockOnSuccess.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the copied bundle detail and adds a toast action with the new bundleId", async () => {
    mockCreateUUIDv7WithSameTimestamp.mockReturnValue("bundle-copy-id");
    mockCreateBundleMutation.mutateAsync.mockResolvedValue(undefined);

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
    fireEvent.change(targetChannelInput, { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(mockCreateBundleMutation.mutateAsync).toHaveBeenCalledWith({
        ...bundle,
        id: "bundle-copy-id",
        channel: "beta",
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
    mockUpdateBundleMutation.mutateAsync.mockResolvedValue(undefined);

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
      expect(mockUpdateBundleMutation.mutateAsync).toHaveBeenCalledWith({
        bundleId: bundle.id,
        bundle: { channel: "beta" },
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
    mockUpdateBundleMutation.mutateAsync.mockResolvedValue(undefined);

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
      expect(mockUpdateBundleMutation.mutateAsync).toHaveBeenCalledWith({
        bundleId: bundle.id,
        bundle: { channel: "nightly" },
      });
    });

    expect(mockSetBundleId).not.toHaveBeenCalled();
    expect(mockOnSuccess).toHaveBeenCalledTimes(1);
  });
});
