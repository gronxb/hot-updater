import { isUUIDv7 } from "@hot-updater/protocol";
import { readProfileServiceUdid } from "@hot-updater/protocol/native-artifact";

import {
  IOS_UDID_PATTERN,
  IOS_UDID_STORAGE_KEY,
  nativeBuildDeviceAddCommand,
  nativeBuildDeviceProfilePath,
} from "../native-builds";
import { escapePlistText } from "./plistText";
import { publicConsoleBase } from "./publicConsoleBase";

/** The most a Profile Service answer holds: a plist and a device's certificates. */
const MAX_RESPONSE_BYTES = 64 * 1024;

const devicePagePath = (id: string) =>
  `/_hot-updater/native-builds/${encodeURIComponent(id)}/device`;

const deviceResponsePath = (id: string) => `${devicePagePath(id)}-response`;

const refusal = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

const methodRefusal = (allow: string) => {
  const response = refusal(405, "Method Not Allowed");
  response.headers.set("allow", allow);
  return response;
};

/**
 * The profile an iPhone installs to report its UDID, at `/_hot-updater/
 * native-builds/<id>/device.mobileconfig`, without a session, since Settings
 * has none. It reads nothing, so it says nothing about the build: the ID is only
 * where the callback's page links back to. It asks for the UDID alone, and iOS
 * keeps no profile afterwards. Anyone can fetch it and learn only their own UDID.
 *
 * - 400: the ID isn't a UUIDv7, or the Console isn't on HTTPS, which iOS needs;
 * - 405: a method other than GET or HEAD.
 */
export const serveDeviceProfile = (request: Request, id: string): Response => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodRefusal("GET, HEAD");
  }
  if (!isUUIDv7(id)) return refusal(400, "Open this from a build's page.");
  const base = publicConsoleBase(request, nativeBuildDeviceProfilePath(id));
  if (!base.startsWith("https://")) {
    return refusal(
      400,
      "An iPhone needs this Console on HTTPS with a certificate it trusts.",
    );
  }
  const host = new URL(base).host;
  const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>${escapePlistText(`${base}${deviceResponsePath(id)}`)}</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
    </array>
    <key>Challenge</key>
    <string>hot-updater</string>
  </dict>
  <key>PayloadOrganization</key>
  <string>Hot Updater</string>
  <key>PayloadDisplayName</key>
  <string>Check this iPhone</string>
  <key>PayloadDescription</key>
  <string>Sends this iPhone's ID (UDID) to ${escapePlistText(host)}, to check whether a build can install on it. Nothing stays installed.</string>
  <key>PayloadIdentifier</key>
  <string>dev.hot-updater.check-this-iphone</string>
  <key>PayloadUUID</key>
  <string>6D3F4C0E-52C4-4C8B-9E0A-7B1E5A0C2F11</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadType</key>
  <string>Profile Service</string>
</dict>
</plist>
`;
  return new Response(request.method === "HEAD" ? null : profile, {
    headers: {
      "cache-control": "no-store",
      "content-disposition":
        'attachment; filename="check-this-iphone.mobileconfig"',
      "content-type": "application/x-apple-aspen-config",
      "x-content-type-options": "nosniff",
    },
  });
};

/** A request's body, or null past `limit` bytes, which are never buffered. */
const readBoundedBody = async (
  request: Request,
  limit: number,
): Promise<Uint8Array | null> => {
  if (Number(request.headers.get("content-length") ?? 0) > limit) {
    await request.body?.cancel().catch(() => {});
    return null;
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const body = new Uint8Array(limit);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return body.subarray(0, length);
      if (length + value.byteLength > limit) return null;
      body.set(value, length);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
};

/**
 * Where iOS posts the device's answer, without a session, since Settings has
 * none. It takes the UDID's text and verifies no signature: nothing automated
 * trusts it, and a forged one only shows on the forger's own screen. A maintainer
 * decides whether a UDID is registered. It reads and stores nothing, and sends
 * the UDID in a fragment, which never reaches a server again. iOS asks for a 301.
 *
 * - 400: no well-formed UDID;
 * - 405: a method other than POST;
 * - 413: a body over 64 KiB.
 */
export const receiveDeviceResponse = async (
  request: Request,
  id: string,
): Promise<Response> => {
  if (request.method !== "POST") return methodRefusal("POST");
  if (!isUUIDv7(id)) return refusal(400, "Open this from a build's page.");
  const body = await readBoundedBody(request, MAX_RESPONSE_BYTES);
  if (body === null) return refusal(413, "This answer is too large.");
  const udid = readProfileServiceUdid(body);
  if (udid === null) return refusal(400, "This answer has no device ID.");
  const base = publicConsoleBase(request, deviceResponsePath(id));
  return new Response(null, {
    status: 301,
    headers: {
      "cache-control": "no-store",
      location: `${base}${devicePagePath(id)}#udid=${encodeURIComponent(udid)}`,
    },
  });
};

const page = ({
  buildId,
  nonce,
}: {
  readonly buildId: string;
  readonly nonce: string;
}) => {
  const [commandStart, commandEnd] =
    nativeBuildDeviceAddCommand("UDID").split("UDID");
  const script = JSON.stringify({
    pattern: IOS_UDID_PATTERN.source,
    key: IOS_UDID_STORAGE_KEY,
    commandStart,
    commandEnd,
  }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<title>This iPhone's ID</title>
<style nonce="${nonce}">
:root { color-scheme: dark light; --bg: #fff; --fg: #1f1d1c; --muted: #6b6661; --line: #e4e0db; --panel: #f6f4f1; --primary: #1f1d1c; --on-primary: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #1f1d1c; --fg: #f6f4f1; --muted: #a8a29c; --line: #3a3633; --panel: #2a2725; --primary: #f6f4f1; --on-primary: #1f1d1c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
main { display: flex; flex-direction: column; gap: 16px; max-width: 32rem; margin: 0 auto; padding: 32px 16px calc(32px + env(safe-area-inset-bottom)); }
h1 { margin: 0; font-size: 22px; line-height: 1.25; }
p { margin: 0; color: var(--muted); font-size: 15px; }
.warning { color: var(--fg); font-weight: 600; }
code { display: block; padding: 12px; overflow-wrap: anywhere; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; font: 14px/1.4 ui-monospace, Menlo, monospace; }
button, a.action { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 44px; padding: 8px 16px; border-radius: 8px; font: inherit; font-weight: 600; text-decoration: none; }
button { border: 0; background: var(--primary); color: var(--on-primary); }
a.action { border: 1px solid var(--line); color: var(--fg); }
[hidden] { display: none; }
</style>
</head>
<body>
<main>
<div id="found" hidden>
  <h1>This iPhone's ID</h1>
</div>
<div id="missing" hidden>
  <h1>No iPhone ID here</h1>
</div>
<code id="udid" hidden translate="no"></code>
<p class="warning" id="warning" hidden>Send this only if this is your iPhone.</p>
<p id="next" hidden>A maintainer runs this command to register the iPhone, then rebuilds. Open the build again afterwards to install it.</p>
<code id="command" hidden translate="no"></code>
<button id="copy" type="button" hidden>Copy command</button>
<p id="retry" hidden>Open the build's page in Safari and check this iPhone again. On a Mac, Finder shows an iPhone's ID, and the same command takes it.</p>
<a class="action" href="../../../native-builds/${encodeURIComponent(buildId)}">Back to the build</a>
</main>
<script nonce="${nonce}">
(function () {
  var c = ${script};
  var pattern = new RegExp(c.pattern, "i");
  var show = function (id) { document.getElementById(id).hidden = false; };
  var stored = function () { try { return localStorage.getItem(c.key); } catch (e) { return null; } };
  var fromLink = new URLSearchParams(location.hash.slice(1)).get("udid");
  var udid = fromLink && pattern.test(fromLink) ? fromLink : stored();
  if (location.hash) history.replaceState(null, "", location.pathname);
  if (!udid || !pattern.test(udid)) { show("missing"); show("retry"); return; }
  try { localStorage.setItem(c.key, udid); } catch (e) {}
  var command = c.commandStart + udid + c.commandEnd;
  document.getElementById("udid").textContent = udid;
  document.getElementById("command").textContent = command;
  ["found", "udid", "warning", "next", "command", "copy"].forEach(show);
  var button = document.getElementById("copy");
  button.addEventListener("click", function () {
    navigator.clipboard.writeText(command).then(function () {
      button.textContent = "Copied";
    }, function () {
      getSelection().selectAllChildren(document.getElementById("command"));
      button.textContent = "Select and copy above";
    });
  });
})();
</script>
</body>
</html>
`;
};

/**
 * The page the callback lands on: the UDID, one command and a copy button,
 * kept in the phone's `localStorage` for the build's page. It takes no session
 * and reads nothing, so Safari with no Console sign-in shows it too, and it
 * works however long a rebuild takes. The UDID comes from the fragment and stays
 * in the browser; a crafted link can show any text, which is why the page asks
 * who the iPhone belongs to.
 *
 * - 400: the ID isn't a UUIDv7;
 * - 405: a method other than GET or HEAD.
 */
export const serveDevicePage = (request: Request, id: string): Response => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodRefusal("GET, HEAD");
  }
  if (!isUUIDv7(id)) return refusal(400, "Open this from a build's page.");
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  );
  return new Response(
    request.method === "HEAD" ? null : page({ buildId: id, nonce }),
    {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
};
