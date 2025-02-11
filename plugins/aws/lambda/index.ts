import { APIGatewayEvent, Context } from "aws-lambda";
import { filterCompatibleAppVersions, getUpdateInfo } from '@hot-updater/js'

export async function handler(event, context) {
  const request = event.Records[0].cf.request;
  const headers = request.headers;

  if (request.uri !== '/api/check-update') {
    return new Response("Not found", { status: 404 });
  }

  const distributionDomain = headers["host"][0]?.value;

  const bundleId = headers["x-bundle-id"][0]?.value;
  const appVersion = headers["x-app-version"][0]?.value;
  const appPlatform = headers["x-app-platform"][0]?.value;

  if (!bundleId || !appPlatform || !appVersion) {
    return new Response(
      JSON.stringify({
        error: "Missing bundleId, appPlatform, or appVersion",
      }),
      { status: 400 },
    );
  }

  const targetAppVersionListUrl = `https://${distributionDomain}/${appPlatform}/targetAppVersionList.json`;

  const targetAppVersionListResponse = await fetch(targetAppVersionListUrl, { method: "GET" });
  if (!targetAppVersionListResponse.ok) {
    return new Response("Failed to fetch targetAppVersionList.json", { status: 404 });
  }

  const targetAppVersionList = await targetAppVersionListResponse.json();

  const matchingVersionList = filterCompatibleAppVersions(targetAppVersionList.files, appVersion);

  if (!matchingVersionList) {
    return new Response(JSON.stringify(null), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  const results = await Promise.allSettled(
    matchingVersionList.map((version: string) => {
      const updateJsonUrl = `https://${distributionDomain}/${appPlatform}/${version}/update.json`;
      return fetch(updateJsonUrl, { method: "GET" }).then(res => res.json())
    })
  )

  const bundles = results.filter(result => result.status === 'fulfilled').map(result => result.value);

  const updateInfo = getUpdateInfo(bundles, { appPlatform, bundleId, appVersion });

  return new Response(JSON.stringify(updateInfo), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
