import type { Bundle } from "@hot-updater/plugin-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BundleEditorForm } from "./BundleEditorForm";

const mockUpdateBundleMutation = {
  isPending: false,
  mutateAsync: vi.fn(),
};

vi.mock("@/lib/api", () => ({
  useUpdateBundleMutation: () => mockUpdateBundleMutation,
}));

vi.mock("./DeleteBundleDialog", () => ({
  DeleteBundleDialog: () => null,
}));

vi.mock("./PromoteChannelDialog", () => ({
  PromoteChannelDialog: () => null,
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
  rolloutPercentage: 100,
  targetDeviceIds: [],
};

describe("BundleEditorForm", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    mockUpdateBundleMutation.isPending = false;
    mockUpdateBundleMutation.mutateAsync.mockReset();
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
});
