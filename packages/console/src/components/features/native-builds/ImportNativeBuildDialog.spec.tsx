import type { NativeArtifactInfo } from "@hot-updater/protocol/native-artifact";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  checkNativeBuildImport,
  navigate,
  readNativeArtifact,
  uploadNativeBuild,
} = vi.hoisted(() => ({
  checkNativeBuildImport: vi.fn(),
  navigate: vi.fn(),
  readNativeArtifact: vi.fn(),
  uploadNativeBuild: vi.fn(),
}));

// The reader has its own specs over real toolchain output; here it stands
// for what the browser reads from a dropped file.
vi.mock("@hot-updater/protocol/native-artifact", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@hot-updater/protocol/native-artifact")
  >()),
  readNativeArtifact,
}));
vi.mock("@/lib/api-rpc", () => ({ checkNativeBuildImport }));
vi.mock("@/lib/native-build-import", () => ({ uploadNativeBuild }));
vi.mock("@/lib/api", () => ({
  queryKeys: { nativeBuilds: { all: ["native-builds"] } },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

import { ImportNativeBuildDialog } from "./ImportNativeBuildDialog";

const MIN_BUNDLE_ID = "019a2b3c-4d5e-7000-8000-000000000000";
const FINGERPRINT = "5de1cdbf".padEnd(64, "0");

const INFO: NativeArtifactInfo = {
  platform: "android",
  kind: "aab",
  appId: "com.example.app",
  appVersion: "1.4.0",
  buildNumber: "42",
  channel: "beta",
  minBundleIdCandidates: [MIN_BUNDLE_ID],
  fingerprintCandidates: [FINGERPRINT],
  builtInBundle: {
    path: "base/assets/index.android.bundle",
    byteSize: 2_000_000,
  },
};

const BUILD = {
  platform: "android",
  kind: "aab",
  appId: "com.example.app",
  buildNumber: "42",
  minBundleId: MIN_BUNDLE_ID,
  channel: "beta",
  fingerprintHash: FINGERPRINT,
  appVersion: null,
  builtInBundlePath: "base/assets/index.android.bundle",
} as const;

const file = () =>
  new File([new Uint8Array(4096)], "app-release.aab", {
    type: "application/octet-stream",
  });

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

const renderDialog = (dropped: File | null = null) => {
  const onOpenChange = vi.fn();
  render(
    <ImportNativeBuildDialog file={dropped} onOpenChange={onOpenChange} open />,
    { wrapper },
  );
  return { onOpenChange };
};

const chooseFile = (chosen: File) =>
  fireEvent.change(screen.getByLabelText("Native build file"), {
    target: { files: [chosen] },
  });

beforeEach(() => {
  vi.clearAllMocks();
  readNativeArtifact.mockResolvedValue(INFO);
  checkNativeBuildImport.mockResolvedValue({
    ok: true,
    updateStrategy: "fingerprint",
    build: BUILD,
  });
});
afterEach(cleanup);

describe("ImportNativeBuildDialog", () => {
  it("shows what a chosen file compiled in before anything is uploaded", async () => {
    renderDialog();
    expect(screen.getByText("Drop a release build here")).toBeTruthy();

    const chosen = file();
    chooseFile(chosen);

    await screen.findByRole("button", { name: "Import build" });
    expect(readNativeArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "app-release.aab",
    );
    expect(checkNativeBuildImport).toHaveBeenCalledWith({ data: INFO });
    for (const text of ["com.example.app", "1.4.0", "beta", MIN_BUNDLE_ID]) {
      expect(screen.getByText(text, { exact: false })).toBeTruthy();
    }
    expect(screen.getByText(FINGERPRINT.slice(0, 12))).toBeTruthy();
    expect(uploadNativeBuild).not.toHaveBeenCalled();
  });

  it("reads a file dropped on the page at once", async () => {
    renderDialog(file());
    await screen.findByRole("button", { name: "Import build" });
    expect(readNativeArtifact).toHaveBeenCalledOnce();
  });

  it("shows every refusal and offers no import", async () => {
    checkNativeBuildImport.mockResolvedValue({
      ok: false,
      updateStrategy: "fingerprint",
      problems: [
        {
          code: "NO_FINGERPRINT",
          message: "The app's code holds no fingerprint.",
        },
        {
          code: "ALREADY_IMPORTED",
          nativeBuildId: "nb-1",
          message: "This build is already registered as native build nb-1.",
        },
      ],
    });
    renderDialog(file());

    await screen.findByText("This build can't be imported");
    expect(
      screen.getByText("The app's code holds no fingerprint."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "This build is already registered as native build nb-1.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import build" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open native build" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/native-builds/nb-1" });
    fireEvent.click(
      screen.getByRole("button", { name: "Choose another file" }),
    );
    expect(screen.getByText("Drop a release build here")).toBeTruthy();
  });

  it("shows a file the browser can't read as a refusal", async () => {
    const { NativeArtifactError } =
      await import("@hot-updater/protocol/native-artifact");
    readNativeArtifact.mockRejectedValue(
      new NativeArtifactError("UNSUPPORTED_FILE", "app.zip is not an .ipa."),
    );
    renderDialog(file());

    await screen.findByText("app.zip is not an .ipa.");
    expect(checkNativeBuildImport).not.toHaveBeenCalled();
  });

  it("uploads with progress, then registers, then opens the build's page", async () => {
    let progress: (sent: number, total: number) => void = () => {};
    let finish: (value: unknown) => void = () => {};
    uploadNativeBuild.mockImplementation(
      (_file: File, onProgress: typeof progress) => {
        progress = onProgress;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const { onOpenChange } = renderDialog(file());
    fireEvent.click(
      await screen.findByRole("button", { name: "Import build" }),
    );

    act(() => progress(1024, 4096));
    expect(screen.getByText("Uploading 1 KB of 4 KB")).toBeTruthy();
    act(() => progress(4096, 4096));
    expect(
      screen.getByText("Storing the built-in bundle and registering the build"),
    ).toBeTruthy();

    await act(async () =>
      finish({
        ok: true,
        nativeBuild: { id: "019a0000-0000-7000-8000-0000000000b1" },
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/native-builds/019a0000-0000-7000-8000-0000000000b1",
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the server's refusal of the upload, and offers to try again", async () => {
    uploadNativeBuild.mockResolvedValue({
      ok: false,
      problems: [{ code: "UNREADABLE", message: "Storage refused the file." }],
    });
    renderDialog(file());
    fireEvent.click(
      await screen.findByRole("button", { name: "Import build" }),
    );

    await screen.findByText("The import didn't finish");
    expect(screen.getByText("Storage refused the file.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(uploadNativeBuild).toHaveBeenCalledTimes(2);
  });
});
