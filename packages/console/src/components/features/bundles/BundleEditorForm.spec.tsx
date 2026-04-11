import { INVALID_COHORT_ERROR_MESSAGE } from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BundleEditorForm } from "./BundleEditorForm";

const {
  mockBundlesQuery,
  mockCreateBundleDiffMutation,
  mockUpdateBundleMutation,
  mockBundleDownloadUrlMutation,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockBundlesQuery: vi.fn(() => ({
    data: {
      data: [],
    },
  })),
  mockCreateBundleDiffMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
  mockUpdateBundleMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
  mockBundleDownloadUrlMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  useBundlesQuery: mockBundlesQuery,
  useBundleDownloadUrlMutation: () => mockBundleDownloadUrlMutation,
  useCreateBundleDiffMutation: () => mockCreateBundleDiffMutation,
  useUpdateBundleMutation: () => mockUpdateBundleMutation,
}));

vi.mock("./DeleteBundleDialog", () => ({
  DeleteBundleDialog: () => null,
}));

vi.mock("./PromoteChannelDialog", () => ({
  PromoteChannelDialog: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
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

describe("BundleEditorForm", () => {
  const originalWindowOpen = window.open;
  let mockDownloadWindow: {
    close: ReturnType<typeof vi.fn>;
    location: { href: string };
    opener: Record<string, never> | null;
  };

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    mockDownloadWindow = {
      close: vi.fn(),
      location: { href: "" },
      opener: {},
    };
    window.open = vi.fn(() => mockDownloadWindow as unknown as Window);
    mockBundleDownloadUrlMutation.isPending = false;
    mockBundleDownloadUrlMutation.mutateAsync.mockReset();
    mockCreateBundleDiffMutation.isPending = false;
    mockCreateBundleDiffMutation.mutateAsync.mockReset();
    mockBundlesQuery.mockReset();
    mockBundlesQuery.mockReturnValue({
      data: {
        data: [],
      },
    });
    mockUpdateBundleMutation.isPending = false;
    mockUpdateBundleMutation.mutateAsync.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  afterEach(() => {
    window.open = originalWindowOpen;
  });

  it("disables save until the form becomes dirty", () => {
    render(<BundleEditorForm bundle={bundle} onClose={() => {}} />);

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    const messageInput = screen.getByLabelText("Message");

    expect(saveButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(messageInput, { target: { value: "Updated message" } });

    expect(saveButton.hasAttribute("disabled")).toBe(false);

    fireEvent.change(messageInput, { target: { value: bundle.message } });

    expect(saveButton.hasAttribute("disabled")).toBe(true);
  });

  it("tracks non-text field changes through the form dirty state", () => {
    render(<BundleEditorForm bundle={bundle} onClose={() => {}} />);

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    const enabledSwitch = screen.getByRole("switch", { name: "Enabled" });

    expect(saveButton.hasAttribute("disabled")).toBe(true);

    fireEvent.click(enabledSwitch);

    expect(saveButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(enabledSwitch);

    expect(saveButton.hasAttribute("disabled")).toBe(true);
  });

  it("shows normalized semver ranges and blocks invalid target app versions", () => {
    render(<BundleEditorForm bundle={bundle} onClose={() => {}} />);

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    const targetAppVersionInput = screen.getByLabelText("Target App Version");

    fireEvent.change(targetAppVersionInput, { target: { value: "invalid" } });

    expect(screen.getByRole("alert").textContent).toBe(
      "Invalid target app version",
    );
    expect(targetAppVersionInput.getAttribute("aria-invalid")).toBe("true");
    expect(saveButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(targetAppVersionInput, {
      target: { value: ">= 1.0.0 < 2.0.0" },
    });

    expect(screen.getByText(">=1.0.0 <2.0.0")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton.hasAttribute("disabled")).toBe(false);
  });

  it("hides target app version for fingerprint bundles", () => {
    render(
      <BundleEditorForm
        bundle={{
          ...bundle,
          targetAppVersion: null,
          fingerprintHash: "fingerprint-hash",
        }}
        onClose={() => {}}
      />,
    );

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    const messageInput = screen.getByLabelText("Message");

    expect(screen.queryByLabelText("Target App Version")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(messageInput, { target: { value: "Updated message" } });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton.hasAttribute("disabled")).toBe(false);
  });

  it("submits the remaining target cohorts after one is removed", async () => {
    mockUpdateBundleMutation.mutateAsync.mockResolvedValue(undefined);

    render(
      <BundleEditorForm
        bundle={{
          ...bundle,
          targetCohorts: ["device-1", "device-2"],
        }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove cohort device-1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateBundleMutation.mutateAsync).toHaveBeenCalledWith({
        bundleId: bundle.id,
        bundle: expect.objectContaining({
          targetCohorts: ["device-2"],
        }),
      });
    });
  });

  it("submits null when the last target cohort is removed", async () => {
    mockUpdateBundleMutation.mutateAsync.mockResolvedValue(undefined);

    render(
      <BundleEditorForm
        bundle={{
          ...bundle,
          targetCohorts: ["device-1"],
        }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove cohort device-1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateBundleMutation.mutateAsync).toHaveBeenCalledWith({
        bundleId: bundle.id,
        bundle: expect.objectContaining({
          targetCohorts: null,
        }),
      });
    });
  });

  it("normalizes cohorts before submitting", async () => {
    mockUpdateBundleMutation.mutateAsync.mockResolvedValue(undefined);

    render(<BundleEditorForm bundle={bundle} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("Enter cohort..."), {
      target: { value: " QA-GROUP " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add cohort" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateBundleMutation.mutateAsync).toHaveBeenCalledWith({
        bundleId: bundle.id,
        bundle: expect.objectContaining({
          targetCohorts: ["qa-group"],
        }),
      });
    });
  });

  it("rejects invalid cohorts", () => {
    render(<BundleEditorForm bundle={bundle} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("Enter cohort..."), {
      target: { value: "Bad Cohort" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add cohort" }));

    expect(mockToastError).toHaveBeenCalledWith(INVALID_COHORT_ERROR_MESSAGE);
  });

  it("rejects cohorts longer than the endpoint-safe limit", () => {
    render(<BundleEditorForm bundle={bundle} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("Enter cohort..."), {
      target: { value: "a".repeat(65) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add cohort" }));

    expect(mockToastError).toHaveBeenCalledWith(INVALID_COHORT_ERROR_MESSAGE);
  });

  it("opens the download URL when Download Bundle is clicked", async () => {
    mockBundleDownloadUrlMutation.mutateAsync.mockResolvedValue({
      fileUrl: "https://example.invalid/bundle.zip",
    });

    render(<BundleEditorForm bundle={bundle} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Download Bundle" }));

    await waitFor(() => {
      expect(mockBundleDownloadUrlMutation.mutateAsync).toHaveBeenCalledWith({
        bundleId: bundle.id,
      });
    });

    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(mockDownloadWindow.location.href).toBe(
      "https://example.invalid/bundle.zip",
    );
  });
});
