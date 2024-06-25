import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/react";

export const loader = ({
  context,
  params,
  request,
  response,
}: LoaderFunctionArgs) => {
  const appVersion = request.headers.get("x-app-version");
  const bundleVersion = request.headers.get("x-bundle-version");

  return json({
    "1.0": [
      {
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 5,
      },
    ],
  });
};
