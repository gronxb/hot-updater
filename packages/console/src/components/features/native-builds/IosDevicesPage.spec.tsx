import type { IosDeviceRow } from "@hot-updater/plugin-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IosDevicesView } from "@/lib/ios-devices-rpc";

const { devicesQuery, profileLinkQuery, approve, rename, remove } = vi.hoisted(
  () => {
    const mutation = () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    });
    return {
      devicesQuery: vi.fn(),
      profileLinkQuery: vi.fn(),
      approve: mutation(),
      rename: mutation(),
      remove: mutation(),
    };
  },
);

vi.mock("@/lib/ios-devices-api", () => ({
  useIosDevicesQuery: devicesQuery,
  useIosDeviceProfileLinkQuery: profileLinkQuery,
  useApproveIosDeviceMutation: () => approve,
  useRenameIosDeviceMutation: () => rename,
  useRemoveIosDeviceMutation: () => remove,
}));
vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { buildId: string };
    children: unknown;
  }) => (
    <a href={params ? to.replace("$buildId", params.buildId) : to} {...props}>
      {children as never}
    </a>
  ),
}));

import { IosDevicesPage } from "./IosDevicesPage";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const device = (overrides: Partial<IosDeviceRow> = {}): IosDeviceRow => ({
  id: "01a1c984-724b-7de1-89a1-c93003b4ff49",
  udid: "00008030-001c2d3e4f5a6b7c",
  name: "Kim's iPhone",
  status: "pending",
  requested_by: "kim@team.dev",
  created_at_ms: Date.now() - 60_000,
  approved_by: null,
  approved_at_ms: null,
  registered_at_ms: null,
  apple_issuer_id: null,
  apple_error: null,
  build_id: null,
  ...overrides,
});

const viewAs = (
  viewer: Partial<IosDevicesView["viewer"]>,
  devices: IosDeviceRow[],
): IosDevicesView => ({
  devices,
  viewer: {
    email: "lead@team.dev",
    canApprove: true,
    approversConfigured: true,
    ...viewer,
  },
  defaultName: "Lead's iPhone",
  registration: "ready",
  secretName: "BETTER_AUTH_SECRET",
});

const show = (view: IosDevicesView, search = {}) => {
  devicesQuery.mockReturnValue({
    data: view,
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  });
  const onSearchChange = vi.fn();
  render(<IosDevicesPage onSearchChange={onSearchChange} search={search} />);
  return { onSearchChange };
};

beforeEach(() => {
  vi.clearAllMocks();
  profileLinkQuery.mockReturnValue({
    data: { status: "issued", token: "cap.sig", expiresAt: "2030-01-01" },
  });
  window.history.replaceState(null, "", "/native-builds/devices");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("IosDevicesPage", () => {
  it("lives in Native builds, beside Builds, with no menu of its own", () => {
    show(viewAs({}, []));
    const nav = screen.getByRole("navigation", { name: "Native builds views" });
    expect(within(nav).getByRole("link", { name: "Builds" })).toBeTruthy();
    expect(
      within(nav)
        .getByRole("link", { name: "iOS devices" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Native builds",
    );
  });

  it("shows a computer the QR code of this page, and an empty list its next step", () => {
    show(viewAs({}, []));
    expect(
      screen.getByRole("img", { name: "Open this page on an iPhone" }),
    ).toBeTruthy();
    expect(screen.getByText("No iPhones yet")).toBeTruthy();
    expect(
      screen.getByText("Open this page on an iPhone to register it."),
    ).toBeTruthy();
    expect(profileLinkQuery).toHaveBeenCalledWith(
      { mode: "register", name: "Lead's iPhone" },
      false,
    );
  });

  it("gives an iPhone its name and the profile, signed for the person", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    Object.defineProperty(window, "location", {
      value: new URL("https://console.example.com/native-builds/devices"),
      configurable: true,
    });
    try {
      show(viewAs({}, []));
      expect(
        (screen.getByLabelText("This iPhone's name") as HTMLInputElement).value,
      ).toBe("Lead's iPhone");
      expect(
        screen
          .getByRole("link", { name: "Install profile" })
          .getAttribute("href"),
      ).toBe("/_hot-updater/devices/device.mobileconfig?t=cap.sig");
    } finally {
      Object.defineProperty(window, "location", {
        value: new URL("http://localhost:3000/native-builds/devices"),
        configurable: true,
      });
    }
  });

  it("lets an approver approve with the slot's cost in view, naming the device", () => {
    show(viewAs({}, [device()]));
    const row = screen.getByRole("row", { name: /Kim's iPhone/ });
    expect(within(row).getByText("Requested")).toBeTruthy();
    expect(within(row).getByText("…5a6b7c")).toBeTruthy();
    expect(within(row).queryByText("00008030-001c2d3e4f5a6b7c")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        /Each new iPhone uses one of the account's 100 a year, and removing it never gives the slot back\./,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("kim@team.dev")).toBeTruthy();
    // The whole UDID, to check against the device: a phone never hovers.
    const udid = within(dialog).getByText("00008030-001c2d3e4f5a6b7c");
    expect(udid.className).toContain("select-all");
    expect(udid.className).toContain("font-mono");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Kim's work iPhone" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(approve.mutate).toHaveBeenCalledWith(
      { id: device().id, name: "Kim's work iPhone" },
      expect.anything(),
    );
  });

  it("gives a requester Withdraw on their own request, and nobody else any action", () => {
    show(
      viewAs({ email: "kim@team.dev", canApprove: false }, [
        device(),
        device({
          id: "01a1c984-724b-7de1-89a1-c93003b4ff50",
          udid: "a".repeat(40),
          name: "Lee's iPad",
          requested_by: "lee@team.dev",
        }),
      ]),
    );
    const own = screen.getByRole("row", { name: /Kim's iPhone/ });
    expect(within(own).getByRole("button", { name: "Withdraw" })).toBeTruthy();
    expect(within(own).queryByRole("button", { name: "Approve" })).toBeNull();
    const other = screen.getByRole("row", { name: /Lee's iPad/ });
    expect(within(other).queryAllByRole("button")).toEqual([]);
  });

  it("says in one line that a removed device stays in builds until Apple disables it, with the command for approvers", () => {
    show(
      viewAs({}, [
        device({
          status: "registered",
          approved_at_ms: 1,
          registered_at_ms: 2,
        }),
      ]),
    );
    const row = screen.getByRole("row", { name: /Kim's iPhone/ });
    fireEvent.click(
      within(row).getByRole("button", {
        name: "More actions for Kim's iPhone",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "It leaves the list. New ad hoc builds keep it until it's disabled at Apple.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/membership year/)).toBeNull();
    expect(
      within(dialog).getByText(
        "npx hot-updater native-build devices remove --udid 00008030-001c2d3e4f5a6b7c",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(remove.mutate).toHaveBeenCalledWith(
      { udid: "00008030-001c2d3e4f5a6b7c" },
      expect.anything(),
    );
  });

  it("marks Apple's refusal of an approved device with a warning in place of Approved, its reason under it", () => {
    show(
      viewAs({}, [
        device({
          status: "approved",
          approved_at_ms: 1,
          apple_error: "The maximum number of devices was reached.",
        }),
        device({
          id: "01a1c984-724b-7de1-89a1-c93003b4ff50",
          udid: "a".repeat(40),
          name: "Lee's iPad",
          status: "approved",
          approved_at_ms: 1,
        }),
      ]),
    );
    const refused = screen.getByRole("row", { name: /Kim's iPhone/ });
    const badge = within(refused).getByText("Apple refused");
    expect(badge.getAttribute("data-variant")).toBe("warning");
    expect(within(refused).queryByText("Approved")).toBeNull();
    expect(
      within(refused).getByText("The maximum number of devices was reached."),
    ).toBeTruthy();
    const approved = screen.getByRole("row", { name: /Lee's iPad/ });
    expect(
      within(approved).getByText("Approved").getAttribute("data-variant"),
    ).toBe("secondary");
  });

  it("names a device the CLI added as added from a terminal, and shows a device with no build as -", () => {
    show(
      viewAs({}, [
        device({ requested_by: null, status: "approved", approved_at_ms: 1 }),
      ]),
    );
    const row = screen.getByRole("row", { name: /Kim's iPhone/ });
    expect(within(row).getByText("Added from a terminal")).toBeTruthy();
    expect(within(row).getByText("-")).toBeTruthy();
    expect(within(row).queryByText("—")).toBeNull();
  });

  it("shows Apple's reason under a registered device's status, and the build that lists a device", () => {
    show(
      viewAs({}, [
        device({
          status: "registered",
          apple_error: "Disabled in the Apple account.",
          build_id: "01a1c997-60fe-7475-bd6c-3a90777fe9f3",
        }),
      ]),
    );
    const row = screen.getByRole("row", { name: /Kim's iPhone/ });
    expect(within(row).getByText("Registered")).toBeTruthy();
    expect(
      within(row).getByText("Disabled in the Apple account."),
    ).toBeTruthy();
    expect(
      within(row)
        .getByRole("link", { name: /Build of/ })
        .getAttribute("href"),
    ).toBe("/native-builds/01a1c997-60fe-7475-bd6c-3a90777fe9f3");
  });

  it("shows no QR code on the local Console, which an iPhone can't reach", () => {
    show({ ...viewAs({}, []), registration: "local-console" });
    expect(screen.queryByRole("img", { name: /iPhone/ })).toBeNull();
    expect(
      screen.getByText(/iPhones register through your hosted Console/),
    ).toBeTruthy();
  });

  it("points to the terminal when nobody approves in this Console", () => {
    show(viewAs({ canApprove: false, approversConfigured: false }, []));
    expect(
      screen.getByText("npx hot-updater native-build devices add"),
    ).toBeTruthy();
  });

  it("filters by status in the URL, and an empty filter offers Show all", () => {
    const { onSearchChange } = show(viewAs({}, []), { status: "approved" });
    expect(devicesQuery).toHaveBeenCalledWith("approved");
    expect(screen.getByText("No approved iPhones")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onSearchChange).toHaveBeenCalledWith({});
  });
});
