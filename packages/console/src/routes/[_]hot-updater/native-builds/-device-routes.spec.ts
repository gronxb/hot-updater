// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConsoleMock, prepareConfigMock, requireConsoleAccessMock } =
  vi.hoisted(() => ({
    loadConsoleMock: vi.fn(),
    prepareConfigMock: vi.fn(),
    requireConsoleAccessMock: vi.fn(),
  }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));
vi.mock("virtual:hot-updater-console/request-guard", () => ({
  default: undefined,
}));
vi.mock("@/lib/server/config.server", () => ({
  loadConsole: loadConsoleMock,
  prepareConfig: prepareConfigMock,
}));
vi.mock("@/lib/server/auth.server", () => ({
  requireConsoleAccess: requireConsoleAccessMock,
}));

import { Route as DeviceResponseRoute } from "../devices/device-response";
import { Route as DeviceProfileRoute } from "../devices/device[.]mobileconfig";
import { Route as ManifestRoute } from "./$buildId/manifest[.]plist";

type Handler = (input: {
  readonly params: { readonly buildId: string };
  readonly request: Request;
}) => Promise<Response>;

const handlerOf = (route: unknown, method: "ANY" | "GET") =>
  (
    route as {
      readonly options: {
        readonly server: { readonly handlers: Record<string, Handler> };
      };
    }
  ).options.server.handlers[method]!;

const BUILD = "019a0000-0000-7000-8000-00000000b001";
const PHONE = "00008030-001C2D3E4F5A6B7C";
const ROUTES = `https://console.example.com/_hot-updater/native-builds/${BUILD}`;
const DEVICES = "https://console.example.com/_hot-updater/devices";

const expectNothingRead = () => {
  expect(loadConsoleMock).not.toHaveBeenCalled();
  expect(prepareConfigMock).not.toHaveBeenCalled();
  expect(requireConsoleAccessMock).not.toHaveBeenCalled();
};

beforeEach(() => vi.clearAllMocks());

describe("an iPhone's profile routes, which take no session", () => {
  it("refuses the profile without a capability, and reads nothing", async () => {
    const response = await handlerOf(
      DeviceProfileRoute,
      "ANY",
    )({
      params: { buildId: BUILD },
      request: new Request(`${DEVICES}/device.mobileconfig`),
    });
    expect(response.status).toBe(403);
    expectNothingRead();
  });

  it("refuses an answer without a capability before loading the Console", async () => {
    const response = await handlerOf(
      DeviceResponseRoute,
      "ANY",
    )({
      params: { buildId: BUILD },
      request: new Request(`${DEVICES}/device-response`, {
        method: "POST",
        body: `<?xml version="1.0"?><plist><dict><key>UDID</key><string>${PHONE}</string></dict></plist>`,
      }),
    });
    expect(response.status).toBe(403);
    expectNothingRead();
  });
});

describe("the install manifest's route", () => {
  it("refuses a request with no token before loading the Console, and asks for no session", async () => {
    const response = await handlerOf(
      ManifestRoute,
      "GET",
    )({
      params: { buildId: BUILD },
      request: new Request(`${ROUTES}/manifest.plist`),
    });
    expect(response.status).toBe(403);
    expectNothingRead();
  });
});
