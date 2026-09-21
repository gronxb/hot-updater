import {
  navigate,
  type SparklingNavigateRequest,
} from "@hot-updater/lynx/navigation";

export const navigationBoundaryVectors = [
  "canonical-options",
  "parameter-count",
  "key-bytes",
  "value-bytes",
  "decoded-query-bytes",
  "raw-route-bytes",
] as const;

type NavigationBoundaryVector = (typeof navigationBoundaryVectors)[number];

const detailPath = "detail.lynx.bundle";
let cursor = 0;
let running = false;

const request = (
  params: Record<string, string | number | boolean>,
): SparklingNavigateRequest => ({ path: detailPath, options: { params } });

export function navigationBoundaryRequests(vector: NavigationBoundaryVector): {
  accepted: SparklingNavigateRequest;
  rejected: readonly SparklingNavigateRequest[];
} {
  if (vector === "canonical-options") {
    return {
      accepted: {
        path: detailPath,
        options: {
          animated: true,
          params: { title: "Second Page", value: "a+b" },
          replace: false,
          useSysBrowser: false,
        },
      },
      rejected: [
        { path: "/detail.lynx.bundle" },
        request({ url: "detail.lynx.bundle" }),
        { path: detailPath, options: { replace: true } } as never,
      ],
    };
  }
  if (vector === "parameter-count") {
    const params = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`p${index}`, index]),
    );
    return {
      accepted: request(params),
      rejected: [request({ ...params, overflow: true })],
    };
  }
  if (vector === "key-bytes") {
    const key = "é".repeat(64);
    return {
      accepted: request({ [key]: "ok" }),
      rejected: [request({ [`${key}a`]: "too-large" })],
    };
  }
  if (vector === "value-bytes") {
    const value = "é".repeat(512);
    return {
      accepted: request({ value }),
      rejected: [request({ value: `${value}a` })],
    };
  }
  if (vector === "decoded-query-bytes") {
    return {
      accepted: request({ a: "a".repeat(1_024), b: "b".repeat(998) }),
      rejected: [request({ a: "a".repeat(1_024), b: "b".repeat(999) })],
    };
  }
  return {
    accepted: request({ a: "é".repeat(512), b: "b".repeat(970) }),
    rejected: [request({ a: "é".repeat(512), b: "b".repeat(971) })],
  };
}

const open = (navigationRequest: SparklingNavigateRequest) =>
  new Promise<number>((resolve) => {
    navigate(navigationRequest, ({ code }) => resolve(code));
  });

export async function verifyNavigationBoundary(
  setStatus: (value: string) => void,
): Promise<void> {
  if (running) return;
  running = true;
  const vector = navigationBoundaryVectors[cursor]!;
  try {
    const requests = navigationBoundaryRequests(vector);
    const acceptedCode = await open(requests.accepted);
    if (acceptedCode !== 1) throw new Error(`accepted code ${acceptedCode}`);
    const rejectedCodes = [];
    for (const rejected of requests.rejected) {
      const code = await open(rejected);
      if (code === 1) throw new Error("unsafe request was accepted");
      rejectedCodes.push(code);
    }
    setStatus(`Navigation boundary ${vector}: max accepted, plus one rejected`);
    console.log(
      "HOT_UPDATER_NAVIGATION_BOUNDARY",
      JSON.stringify({ acceptedCode, rejectedCodes, vector }),
    );
    cursor = (cursor + 1) % navigationBoundaryVectors.length;
  } catch (error) {
    setStatus(`Navigation boundary ${vector}: failed`);
    console.error("HOT_UPDATER_NAVIGATION_BOUNDARY_FAILURE", String(error));
  } finally {
    running = false;
  }
}
