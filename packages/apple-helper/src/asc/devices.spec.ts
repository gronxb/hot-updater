import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { addAscDevices, listAscDevices } from "./devices";

const PHONE = "00008030-001C2D3E4F5A6B7C";
const OTHER_PHONE = "00008110-000A1B2C3D4E5F60";

let directory: string;
let apiKey: { keyPath: string; keyId: string; issuerId: string };

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "asc-devices-"));
  const keyPath = path.join(directory, "AuthKey.p8");
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  fs.writeFileSync(
    keyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  apiKey = { keyPath, keyId: "ABC", issuerId: "issuer" };
});

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

interface RegisteredDevice {
  udid: string;
  name: string;
  status: string;
  deviceClass?: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const row = (device: RegisteredDevice, index: number) => ({
  id: `D${index}`,
  type: "devices",
  attributes: device,
});

/**
 * App Store Connect's Devices API over a registry, as its public documentation
 * describes the requests: every request is kept, so a spec can count writes.
 */
const appStoreConnect = (
  registry: RegisteredDevice[] = [],
  onCreate?: (udid: string) => Response | undefined,
) => {
  const requests: { method: string; url: URL; body: any }[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url, body });
      expect(url.pathname).toBe("/v1/devices");
      if (method === "GET") {
        const filter = url.searchParams.get("filter[udid]")?.split(",");
        return json(200, {
          data: registry
            .filter(({ udid }) => filter === undefined || filter.includes(udid))
            .map(row),
        });
      }
      const { udid, name } = body.data.attributes as Record<string, string>;
      const answer = onCreate?.(udid);
      if (answer) return answer;
      registry.push({ udid: udid!, name: name!, status: "ENABLED" });
      return json(201, { data: row(registry.at(-1)!, registry.length - 1) });
    },
  ) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    registry,
    requests,
    writes: () => requests.filter(({ method }) => method === "POST"),
  };
};

describe("addAscDevices", () => {
  it("registers a new iPhone with what the API asks for, only reading the UDIDs it was given", async () => {
    const asc = appStoreConnect();

    const outcomes = await addAscDevices({
      devices: [{ udid: PHONE, name: "Kim's iPhone" }],
      apiKey,
      fetch: asc.fetch,
    });

    expect(outcomes).toMatchObject([
      { udid: PHONE, outcome: "registered", device: { name: "Kim's iPhone" } },
    ]);
    expect(asc.writes()).toHaveLength(1);
    expect(asc.writes()[0]!.body).toEqual({
      data: {
        type: "devices",
        attributes: { name: "Kim's iPhone", platform: "IOS", udid: PHONE },
      },
    });
    const read = asc.requests[0]!;
    expect(read.url.searchParams.get("filter[udid]")).toBe(PHONE);
    expect(read.url.searchParams.get("filter[platform]")).toBe("IOS");
  });

  it("is idempotent: a second run writes nothing, whatever the case of the UDID", async () => {
    const asc = appStoreConnect();
    const add = (udid: string) =>
      addAscDevices({
        devices: [{ udid, name: "iPhone" }],
        apiKey,
        fetch: asc.fetch,
      });

    await add(PHONE);
    const again = await add(PHONE);

    expect(again).toMatchObject([{ outcome: "already-registered" }]);
    expect(asc.writes()).toHaveLength(1);
    expect(asc.registry).toHaveLength(1);
  });

  it("takes several at once, in one read, and registers only the new ones", async () => {
    const asc = appStoreConnect([
      { udid: PHONE, name: "Existing", status: "ENABLED" },
    ]);

    const outcomes = await addAscDevices({
      devices: [
        { udid: PHONE, name: "New name" },
        { udid: OTHER_PHONE, name: "Other" },
      ],
      apiKey,
      fetch: asc.fetch,
    });

    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      "already-registered",
      "registered",
    ]);
    expect(asc.requests.filter(({ method }) => method === "GET")).toHaveLength(
      1,
    );
    expect(asc.requests[0]!.url.searchParams.get("filter[udid]")).toBe(
      `${PHONE},${OTHER_PHONE}`,
    );
    expect(asc.registry[0]!.name).toBe("Existing");
  });

  it("treats losing a race with another run as already registered", async () => {
    const asc = appStoreConnect([], (udid) => {
      asc.registry.push({ udid, name: "Theirs", status: "ENABLED" });
      return json(409, {
        errors: [{ code: "ENTITY_ERROR", detail: "already exists" }],
      });
    });

    const outcomes = await addAscDevices({
      devices: [{ udid: PHONE, name: "Mine" }],
      apiKey,
      fetch: asc.fetch,
    });

    expect(outcomes).toMatchObject([
      { outcome: "already-registered", device: { name: "Theirs" } },
    ]);
  });

  it("reports a disabled device and leaves it disabled", async () => {
    const asc = appStoreConnect([
      { udid: PHONE, name: "Old", status: "DISABLED" },
    ]);

    const outcomes = await addAscDevices({
      devices: [{ udid: PHONE, name: "New" }],
      apiKey,
      fetch: asc.fetch,
    });

    expect(outcomes).toMatchObject([{ outcome: "disabled" }]);
    expect(asc.writes()).toHaveLength(0);
  });

  it("reports the account's yearly limit in Apple's words, and goes on to the next", async () => {
    const asc = appStoreConnect([], (udid) =>
      udid === PHONE
        ? json(409, {
            errors: [
              {
                code: "ENTITY_ERROR",
                title:
                  "The provided entity includes an attribute with an invalid value",
                detail:
                  "You have reached the maximum number of registered iPhone devices.",
              },
            ],
          })
        : undefined,
    );

    const outcomes = await addAscDevices({
      devices: [
        { udid: PHONE, name: "One" },
        { udid: OTHER_PHONE, name: "Two" },
      ],
      apiKey,
      fetch: asc.fetch,
    });

    expect(outcomes).toEqual([
      {
        udid: PHONE,
        outcome: "refused",
        reason:
          "You have reached the maximum number of registered iPhone devices.",
        limitReached: true,
      },
      expect.objectContaining({ udid: OTHER_PHONE, outcome: "registered" }),
    ]);
  });

  it("reports any other refusal without calling it the limit", async () => {
    const asc = appStoreConnect([], () =>
      json(409, {
        errors: [
          { code: "ENTITY_ERROR.ATTRIBUTE.INVALID", detail: "udid is invalid" },
        ],
      }),
    );

    const outcomes = await addAscDevices({
      devices: [{ udid: PHONE, name: "One" }],
      apiKey,
      fetch: asc.fetch,
    });

    expect(outcomes).toMatchObject([
      { outcome: "refused", reason: "udid is invalid", limitReached: false },
    ]);
  });

  it("says a key can't register devices, rather than speak of uploads, on a 403", async () => {
    const asc = appStoreConnect([], () =>
      json(403, {
        errors: [{ code: "FORBIDDEN_ERROR", detail: "not allowed" }],
      }),
    );

    await expect(
      addAscDevices({
        devices: [{ udid: PHONE, name: "One" }],
        apiKey,
        fetch: asc.fetch,
      }),
    ).rejects.toThrow(
      "App Store Connect doesn't let this API key register devices.\nUse a key with the Admin role: npx hot-updater apple login",
    );
    expect(asc.registry).toHaveLength(0);
  });

  it("keeps the program license message for a 403 that is about that", async () => {
    const asc = appStoreConnect([], () =>
      json(403, {
        errors: [
          {
            code: "FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED",
            detail: "agreement",
          },
        ],
      }),
    );

    await expect(
      addAscDevices({
        devices: [{ udid: PHONE, name: "One" }],
        apiKey,
        fetch: asc.fetch,
      }),
    ).rejects.toThrow(/License Agreement/iu);
  });

  it("surfaces a key App Store Connect refuses outright", async () => {
    const fetch = vi.fn(async () => json(401, { errors: [] })) as never;
    await expect(
      addAscDevices({
        devices: [{ udid: PHONE, name: "One" }],
        apiKey,
        fetch,
      }),
    ).rejects.toThrow(/refused the API key/u);
  });
});

describe("listAscDevices", () => {
  it("reads every page, on App Store Connect's host only", async () => {
    const pages = [
      {
        data: [
          row(
            {
              udid: PHONE,
              name: "A",
              status: "ENABLED",
              deviceClass: "IPHONE",
            },
            0,
          ),
        ],
        links: {
          next: "https://api.appstoreconnect.apple.com/v1/devices?cursor=2",
        },
      },
      {
        data: [
          row(
            {
              udid: OTHER_PHONE,
              name: "B",
              status: "DISABLED",
              deviceClass: "IPAD",
            },
            1,
          ),
        ],
      },
    ];
    const fetch = vi.fn(async () => json(200, pages.shift())) as never;

    expect(await listAscDevices({ apiKey, fetch })).toEqual([
      {
        id: "D0",
        udid: PHONE,
        name: "A",
        status: "ENABLED",
        deviceClass: "IPHONE",
      },
      {
        id: "D1",
        udid: OTHER_PHONE,
        name: "B",
        status: "DISABLED",
        deviceClass: "IPAD",
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a next page on another host, which the key's token would go to", async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        data: [],
        links: { next: "https://elsewhere.example.com/v1/devices?cursor=2" },
      }),
    ) as never;

    await expect(listAscDevices({ apiKey, fetch })).rejects.toThrow(
      /another host/u,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
