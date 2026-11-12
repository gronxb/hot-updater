import type { IosDeviceRow } from "@hot-updater/plugin-core";
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

import type { IosDevicesView } from "@/lib/ios-devices-rpc";

import { IosDevicesPage } from "./IosDevicesPage";

// The real query hooks over the server functions, so a disabled read stays
// unread and every request that would reach the server is counted here.
const rpc = vi.hoisted(() => ({
  getIosDevices: vi.fn(),
  getIosDevice: vi.fn(),
  createIosDeviceProfileLink: vi.fn(),
  requestIosDeviceAccess: vi.fn(),
  approveIosDevice: vi.fn(),
  renameIosDevice: vi.fn(),
  removeIosDevice: vi.fn(),
  getNativeBuildIpaDevices: vi.fn(),
}));
vi.mock("@/lib/ios-devices-rpc", () => rpc);
vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const PHONE = "00008160-000239A910A3400A";
const OTHER = "00008130-000E1F2A3B4C5D6E";

const row = (udid: string): IosDeviceRow => ({
  id: `device-${udid}`,
  udid: udid.toLowerCase(),
  name: "Sungyu Kang's iPhone",
  status: "pending",
  requested_by: "kim@team.dev",
  created_at_ms: Date.now() - 60_000,
  approved_by: null,
  approved_at_ms: null,
  registered_at_ms: null,
  apple_issuer_id: null,
  apple_error: null,
  build_id: null,
});

const view: IosDevicesView = {
  devices: [],
  viewer: {
    email: "kim@team.dev",
    canApprove: false,
    approversConfigured: true,
  },
  defaultName: "Kim's iPhone",
  registration: "ready",
  secretName: "BETTER_AUTH_SECRET",
};

/** The UDIDs the single-device read was asked for, in order. */
const lookups = () =>
  rpc.getIosDevice.mock.calls.map(
    ([input]) => (input as { data: { udid: unknown } }).data.udid,
  );

const show = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <IosDevicesPage onSearchChange={vi.fn()} search={{}} />
    </QueryClientProvider>,
  );
};

const answer = (udid: string) =>
  act(() => {
    window.history.replaceState(
      null,
      "",
      `/native-builds/devices#udid=${udid}&requested=1`,
    );
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/native-builds/devices");
  rpc.getIosDevices.mockResolvedValue(view);
  rpc.createIosDeviceProfileLink.mockResolvedValue({
    status: "issued",
    token: "cap.sig",
    expiresAt: "2030-01-01",
  });
  rpc.getIosDevice.mockImplementation(async ({ data }) =>
    typeof data?.udid === "string"
      ? row(data.udid)
      : Promise.reject(new TypeError("Invalid udid.")),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("this iPhone's row, read with the real query", () => {
  it("reads only the new ID on the first return to a tab that had none", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    show();
    await screen.findByText("iPhones need this Console on HTTPS.");
    expect(lookups()).toEqual([]);

    answer(PHONE);

    await waitFor(() => expect(lookups()).toEqual([PHONE]));
    await screen.findByText("Requested");
    expect(lookups()).toEqual([PHONE]);
  });

  it("reads nothing on a computer, whatever the fragment", async () => {
    window.localStorage.setItem("hot-updater-ios-udid", PHONE);
    show();
    await screen.findByRole("img", { name: "Open this page on an iPhone" });

    act(() => {
      window.location.hash = "test";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    answer(OTHER);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rpc.getIosDevice).not.toHaveBeenCalled();
  });

  it("reads nothing on an iPhone with no ID when an unrelated fragment changes", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    show();
    await screen.findByText("iPhones need this Console on HTTPS.");

    act(() => {
      window.location.hash = "test";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rpc.getIosDevice).not.toHaveBeenCalled();
  });

  it("reads the same ID once more when its answer comes back, and only then", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    window.localStorage.setItem("hot-updater-ios-udid", PHONE);
    show();
    await screen.findByText("Requested");
    expect(lookups()).toEqual([PHONE]);

    act(() => {
      window.location.hash = "test";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookups()).toEqual([PHONE]);

    answer(PHONE);
    await waitFor(() => expect(lookups()).toEqual([PHONE, PHONE]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookups()).toEqual([PHONE, PHONE]);
  });

  it("reads the new ID, not the old one, when an answer brings a different iPhone", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    window.localStorage.setItem("hot-updater-ios-udid", OTHER);
    show();
    await screen.findByText("Requested");
    expect(lookups()).toEqual([OTHER]);

    answer(PHONE);

    await waitFor(() => expect(lookups()).toEqual([OTHER, PHONE]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookups()).toEqual([OTHER, PHONE]);
  });

  describe("Refresh and Retry", () => {
    const approved = (udid: string): IosDeviceRow => ({
      ...row(udid),
      status: "approved",
      approved_at_ms: Date.now(),
    });

    it("read this iPhone's row again with the list, so an approval made elsewhere shows on the card", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      show();
      await screen.findByText("Requested");

      // A maintainer approves it from another session.
      rpc.getIosDevice.mockImplementation(async ({ data }) =>
        approved(data.udid),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh iOS devices" }),
      );

      expect(
        await screen.findByText("It joins the next ad hoc build."),
      ).toBeTruthy();
      expect(lookups()).toEqual([PHONE, PHONE]);
    });

    it("Retry after a failed list reads this iPhone's row again too", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      rpc.getIosDevices.mockRejectedValueOnce(new Error("offline"));
      show();
      await screen.findByText("iOS devices couldn't be loaded");
      await screen.findByText("Requested");

      rpc.getIosDevice.mockImplementation(async ({ data }) =>
        approved(data.udid),
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(
        await screen.findByText("It joins the next ad hoc build."),
      ).toBeTruthy();
      expect(rpc.getIosDevices).toHaveBeenCalledTimes(2);
    });

    it("reads no single row on a computer when Refresh is pressed", async () => {
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      show();
      await screen.findByRole("img", { name: "Open this page on an iPhone" });
      await waitFor(() => expect(rpc.getIosDevices).toHaveBeenCalledTimes(1));

      fireEvent.click(
        screen.getByRole("button", { name: "Refresh iOS devices" }),
      );

      await waitFor(() => expect(rpc.getIosDevices).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rpc.getIosDevice).not.toHaveBeenCalled();
    });
  });

  it("trades a held receipt again only on Refresh after a failure, never on its own", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    const held = `${btoa(
      JSON.stringify({ u: PHONE, x: Date.now() + 60 * 60 * 1000 }),
    ).replaceAll("=", "")}.sig`;
    window.localStorage.setItem("hot-updater-ios-udid", PHONE);
    window.sessionStorage.setItem(
      "hot-updater-ios-device-pending-receipt",
      JSON.stringify({ udid: PHONE, receipt: held }),
    );
    rpc.getIosDevice.mockResolvedValue(null);
    const trades: string[] = [];
    let up = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          trades.push(url);
          if (!up) throw new TypeError("Network failed");
          return new Response(JSON.stringify({ udid: PHONE }));
        }
        return new Response(JSON.stringify({ udid: up ? PHONE : null }));
      }),
    );
    try {
      show();
      await waitFor(() => expect(trades.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 100));
      // One failed trade, shared by the page and the read: no loop.
      expect(trades).toHaveLength(1);

      up = true;
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh iOS devices" }),
      );
      await waitFor(() => expect(trades).toHaveLength(2));
      await waitFor(() =>
        expect(
          window.sessionStorage.getItem(
            "hot-updater-ios-device-pending-receipt",
          ),
        ).toBeNull(),
      );
    } finally {
      vi.unstubAllGlobals();
      window.sessionStorage.clear();
    }
  });
});
