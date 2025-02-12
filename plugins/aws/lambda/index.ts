import { filterCompatibleAppVersions, getUpdateInfo } from '@hot-updater/js'
import type { CloudFrontRequestEvent } from 'aws-lambda'

export async function handler(event: CloudFrontRequestEvent) {
  const request = event.Records[0].cf.request;
  const headers = request.headers;

  if (request.uri !== '/api/check-update') {
    return new Response("Not found", { status: 404 });
  }

  const distributionDomain = headers["host"][0]?.value;

  const bundleId = headers["x-bundle-id"][0]?.value as string;
  const appPlatform = headers["x-app-platform"][0]?.value as
    | "ios"
    | "android";
  const appVersion = headers["x-app-version"][0]?.value as string;

  if (!bundleId || !appPlatform || !appVersion) {
    return new Response(
      JSON.stringify({
        error: "Missing bundleId, appPlatform, or appVersion",
      }),
      { status: 400 },
    );
  }

  const targetAppVersionListUrl = `https://${distributionDomain}/${appPlatform}/target-app-versions.json`;

  const targetAppVersionListResponse = await fetch(targetAppVersionListUrl, { method: "GET" });
  if (!targetAppVersionListResponse.ok) {
    return new Response("Failed to fetch targetAppVersionList.json", { status: 404 });
  }

  const targetAppVersionList = await targetAppVersionListResponse.json();

  const matchingVersionList = filterCompatibleAppVersions(targetAppVersionList, appVersion);

  if (!matchingVersionList) {
    return new Response(JSON.stringify(null), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  const results = await Promise.allSettled(
    matchingVersionList.map(async (version: string) => {
      const updateJsonUrl = `https://${distributionDomain}/${appPlatform}/${version}/update.json`;
      const res = await fetch(updateJsonUrl, { method: "GET" });
      return await res.json();
    })
  )

  const bundles = results.filter(result => result.status === 'fulfilled').map(result => result.value);

  const updateInfo = await getUpdateInfo(bundles, { platform: appPlatform, bundleId, appVersion });

  return new Response(JSON.stringify(updateInfo), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
