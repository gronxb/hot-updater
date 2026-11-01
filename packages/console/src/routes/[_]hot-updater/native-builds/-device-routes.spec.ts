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

import { Route as DeviceRoute } from "./$buildId/device";
import { Route as DeviceResponseRoute } from "./$buildId/device-response";
import { Route as DeviceProfileRoute } from "./$buildId/device[.]mobileconfig";
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

const expectNothingRead = () => {
  expect(loadConsoleMock).not.toHaveBeenCalled();
  expect(prepareConfigMock).not.toHaveBeenCalled();
  expect(requireConsoleAccessMock).not.toHaveBeenCalled();
};

beforeEach(() => vi.clearAllMocks());

describe("a tester's routes, which take no session", () => {
  it("serves the profile with no read", async () => {
    const response = await handlerOf(
      DeviceProfileRoute,
      "ANY",
    )({
      params: { buildId: BUILD },
      request: new Request(`${ROUTES}/device.mobileconfig`),
    });
    expect(response.status).toBe(200);
    expectNothingRead();
  });

  it("takes the callback's answer with no read", async () => {
    const response = await handlerOf(
      DeviceResponseRoute,
      "ANY",
    )({
      params: { buildId: BUILD },
      request: new Request(`${ROUTES}/device-response`, {
        method: "POST",
        body: `<?xml version="1.0"?><plist><dict><key>UDID</key><string>${PHONE}</string></dict></plist>`,
      }),
    });
    expect(response.status).toBe(301);
    expectNothingRead();
  });

  it("serves the page with no read", async () => {
    const response = await handlerOf(
      DeviceRoute,
      "ANY",
    )({
      params: { buildId: BUILD },
      request: new Request(`${ROUTES}/device`),
    });
    expect(response.status).toBe(200);
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
