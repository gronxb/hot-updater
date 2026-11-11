import type { NativeBuildRow } from "@hot-updater/plugin-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IpaDevicesCard } from "./IpaDevicesCard";

const { ipaDevicesQuery } = vi.hoisted(() => ({ ipaDevicesQuery: vi.fn() }));

vi.mock("@/lib/ios-devices-api", () => ({
  useNativeBuildIpaDevicesQuery: ipaDevicesQuery,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const build = { id: "019a0000-0000-7000-8000-000000000001" } as NativeBuildRow;
const KNOWN = "00008030-001c2d3e4f5a6b7c";
const UNKNOWN = "00008110-001a2b3c4d5e6f70";

describe("IpaDevicesCard", () => {
  it("gives every device one shape: its name, or Unknown device, over its masked UDID, which copies the whole UDID", async () => {
    ipaDevicesQuery.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        status: "listed",
        devices: [
          { udid: KNOWN, name: "Kim's iPhone" },
          { udid: UNKNOWN, name: null },
        ],
      },
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<IpaDevicesCard build={build} />);

    const [known, unknown] = within(
      screen.getByRole("list", { name: "Devices in this build" }),
    ).getAllByRole("listitem");
    expect(within(known!).getByText("Kim's iPhone")).toBeTruthy();
    expect(within(known!).getByText("…5a6b7c")).toBeTruthy();
    expect(within(unknown!).getByText("Unknown device")).toBeTruthy();
    expect(within(unknown!).getByText("…5e6f70")).toBeTruthy();
    // The full UDID is never the row's text, only what the control copies.
    expect(screen.queryByText(UNKNOWN)).toBeNull();
    fireEvent.click(
      within(unknown!).getByRole("button", {
        name: `Copy the UDID ${UNKNOWN}`,
      }),
    );
    expect(writeText).toHaveBeenCalledWith(UNKNOWN);
  });
});
