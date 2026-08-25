import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BundleSigningInspection } from "@/lib/bundle-signing-rpc";

import { BundleSigningPage } from "./BundleSigningPage";

const { inspectionQuery, toastError, toastSuccess } = vi.hoisted(() => ({
  inspectionQuery: {
    data: undefined as BundleSigningInspection | undefined,
    error: null as Error | null,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

vi.mock("@/lib/bundle-signing-api", () => ({
  useBundleSigningInspectionQuery: () => inspectionQuery,
}));

describe("BundleSigningPage", () => {
  beforeEach(() => {
    inspectionQuery.data = undefined;
    inspectionQuery.error = null;
    inspectionQuery.isError = false;
    inspectionQuery.isLoading = false;
    inspectionQuery.refetch.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  afterEach(cleanup);

  it("shows only public signing metadata and read-only actions", async () => {
    const publicKey =
      "-----BEGIN PUBLIC KEY-----\npublic-material\n-----END PUBLIC KEY-----";
    inspectionQuery.data = {
      algorithm: "RSA-SHA256",
      fingerprint: "a".repeat(64),
      provider: "Local file",
      publicKey,
      status: "enabled",
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<BundleSigningPage />);

    expect(screen.getByText("Enabled")).toBeDefined();
    expect(screen.getByText("Local file")).toBeDefined();
    expect(screen.getByText("RSA-SHA256")).toBeDefined();
    expect(screen.getByText("a".repeat(64))).toBeDefined();
    expect(
      (
        screen.getByLabelText(
          "Bundle signing public key",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe(publicKey);
    expect(screen.getByText("Read-only inspection")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /generate|import|rotate|delete/i }),
    ).toBeNull();
    expect(screen.queryByText(/private-key\.pem|private key path/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(publicKey));
    expect(toastSuccess).toHaveBeenCalledWith("Public key copied");
  });

  it("explains disabled signing without rendering a public key", () => {
    inspectionQuery.data = { status: "disabled" };

    render(<BundleSigningPage />);

    expect(screen.getByText("Disabled")).toBeDefined();
    expect(
      screen.getByText("Configure signing outside the Console"),
    ).toBeDefined();
    expect(screen.queryByLabelText("Bundle signing public key")).toBeNull();
  });

  it("shows a sanitized misconfiguration without management actions", () => {
    inspectionQuery.data = {
      message: "The configured public key could not be loaded.",
      provider: "Managed signing",
      status: "misconfigured",
    };

    render(<BundleSigningPage />);

    expect(screen.getByText("Misconfigured")).toBeDefined();
    expect(screen.getByText("Managed signing")).toBeDefined();
    expect(
      screen.getByText("The configured public key could not be loaded."),
    ).toBeDefined();
    expect(document.body.textContent).not.toMatch(/\/secret\/|private-key/u);
  });

  it("offers retry without exposing the server error", () => {
    inspectionQuery.error = new Error("/secret/provider/public-key.pem");
    inspectionQuery.isError = true;

    render(<BundleSigningPage />);

    expect(screen.getByText("Bundle signing couldn't be loaded")).toBeDefined();
    expect(screen.queryByText("/secret/provider/public-key.pem")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(inspectionQuery.refetch).toHaveBeenCalledOnce();
  });

  it("renders a stable loading shell", () => {
    inspectionQuery.isLoading = true;

    render(<BundleSigningPage />);

    expect(screen.getByLabelText("Loading bundle signing")).toBeDefined();
  });
});
