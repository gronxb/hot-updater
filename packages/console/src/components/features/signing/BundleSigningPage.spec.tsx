import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BundleSigningInspection } from "@/lib/bundle-signing-rpc";

import { BundleSigningPage } from "./BundleSigningPage";

const { inspectionQuery } = vi.hoisted(() => ({
  inspectionQuery: {
    data: undefined as BundleSigningInspection | undefined,
    error: null as Error | null,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  },
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
  });

  afterEach(cleanup);

  it("shows only non-secret signing metadata", () => {
    inspectionQuery.data = {
      algorithm: "RSA-SHA256",
      provider: "Local file",
      status: "enabled",
    };

    render(<BundleSigningPage />);

    expect(screen.getByText("Enabled")).toBeDefined();
    expect(screen.getByText("Local file")).toBeDefined();
    expect(screen.getByText("RSA-SHA256")).toBeDefined();
    expect(screen.getByText("Read-only inspection")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /generate|import|rotate|delete/i }),
    ).toBeNull();
    expect(screen.queryByText(/private-key\.pem|private key path/i)).toBeNull();
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
