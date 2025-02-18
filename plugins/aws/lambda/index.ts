import type { Bundle } from "@hot-updater/core";
import { filterCompatibleAppVersions, getUpdateInfo } from "@hot-updater/js";
import type { CloudFrontRequestHandler } from "aws-lambda";

export const handler: CloudFrontRequestHandler = async (event, context, callback) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;

  if (request.uri !== "/api/check-update") {
    return request;
  }

  const distributionDomain = headers["host"][0]?.value;

  const bundleId = headers["x-bundle-id"]?.[0]?.value as string;
  const appPlatform = headers["x-app-platform"]?.[0]?.value as "ios" | "android";
  const appVersion = headers["x-app-version"]?.[0]?.value as string;

  if (!bundleId || !appPlatform || !appVersion) {
    callback(null, {
      status: "400",
      body: JSON.stringify({
        error: "Missing bundleId, appPlatform, or appVersion",
      }),
    });
    return;
  }

  const targetAppVersionListUrl = `https://${distributionDomain}/${appPlatform}/target-app-versions.json`;

  const targetAppVersionListResponse = await fetch(targetAppVersionListUrl, {
    method: "GET",
  });
  if (!targetAppVersionListResponse.ok) {
    callback(null, {
      status: "404",
      body: JSON.stringify({
        error: `Failed to fetch ${appPlatform}/target-app-versions.json`,
      }),
    });
    return;
  }

  const targetAppVersionList =
    (await targetAppVersionListResponse.json()) as string[];

  const matchingVersionList = filterCompatibleAppVersions(
    targetAppVersionList,
    appVersion,
  );

  if (!matchingVersionList) {
    callback(null, {
      status: "200",
      headers: {
        "Content-Type": [{ key: "Content-Type", value: "application/json" }],
      },
      body: JSON.stringify(null),
    });
    return;
  }

  const results = await Promise.allSettled(
    matchingVersionList.map(async (version: string) => {
      const updateJsonUrl = `https://${distributionDomain}/${appPlatform}/${version}/update.json`;
      const res = await fetch(updateJsonUrl, { method: "GET" });
      return await res.json();
    }),
  );

  const bundles = results
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value) as Bundle[];

  const updateInfo = await getUpdateInfo(bundles, {
    platform: appPlatform,
    bundleId,
    appVersion,
  });

  callback(null, {
    status: "200",
    headers: {
      "Content-Type": [{ key: "Content-Type", value: "application/json" }],
    },
    body: JSON.stringify(updateInfo),
  });
};
