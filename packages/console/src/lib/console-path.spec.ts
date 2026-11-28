import { describe, expect, it } from "vitest";

import {
  consolePathFromRouter,
  consolePathOfNativeBuildsPage,
} from "./native-builds";

describe("the Console's own path", () => {
  it.each([
    ["/console/insights", "/insights", "/console"],
    ["/console/", "/", "/console"],
    ["/console", "/", "/console"],
    ["/insights", "/insights", ""],
    ["/", "/", ""],
  ])("finds %s under the router's %s as %j", (pathname, route, base) => {
    expect(consolePathFromRouter({ pathname }, route)).toBe(base);
  });

  it.each([
    ["/console/native-builds/devices", "/console"],
    ["/console/native-builds/019a-0001", "/console"],
    ["/native-builds/devices", ""],
  ])("finds the path before a Native builds page in %s", (pathname, base) => {
    expect(consolePathOfNativeBuildsPage({ pathname })).toBe(base);
  });
});
