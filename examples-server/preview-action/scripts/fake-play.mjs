// A stand-in for Google's token endpoint and the Google Play Developer API,
// loaded into the CLI with `node --import`, so the CLI's real upload runs with
// no store behind it and no store setting in the product. It answers as
// Google Play does: an edit holds an upload until its commit, and a version
// code is taken once. Any other Google or Apple host throws, so the proof can't
// reach a real store. Each commit, and each refusal, appends a line to
// PROOF_PLAY_LOG, which the proof reads as the store's own record:
//
//   { "versionCode": 1, "sha256": "...", "size": 123 }
//   { "refused": "commit" }
//
// PROOF_PLAY_VERSION_CODE is the version code the store reads from the next
// .aab. PROOF_PLAY_FAIL=commit refuses the commit, as a store outage would.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const API = "https://androidpublisher.googleapis.com";
const TOKEN = "https://oauth2.googleapis.com";
const STORES = /(^|\.)(googleapis\.com|play\.google\.com|apple\.com)$/;

const log = () => {
  const file = process.env.PROOF_PLAY_LOG;
  if (!file) throw new Error("PROOF_PLAY_LOG is not set.");
  return file;
};

const committed = () =>
  existsSync(log())
    ? readFileSync(log(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((line) => line.refused === undefined)
    : [];

const record = (line) => appendFileSync(log(), `${JSON.stringify(line)}\n`);

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const refuse = (status, message) => json({ error: { message } }, status);

const versionCode = () => Number(process.env.PROOF_PLAY_VERSION_CODE ?? "1");

/** The edits this process opened. */
const edits = new Map();
let nextEdit = 0;

const answer = async (url, { method = "GET", headers, body } = {}) => {
  const path = url.pathname;
  const editId = /\/edits\/([^/:]+)/.exec(path)?.[1];
  if (method === "POST" && path.endsWith("/edits")) {
    const id = `proof-edit-${process.pid}-${nextEdit++}`;
    edits.set(id, { chunks: [], release: null });
    return json({ id });
  }
  if (path.includes("/upload/") && path.endsWith("/bundles")) {
    return new Response(null, {
      status: 200,
      headers: { Location: `${API}/proof-upload/${editId}` },
    });
  }
  if (method === "PUT" && path.startsWith("/proof-upload/")) {
    const edit = edits.get(path.split("/").at(-1));
    const range = new Headers(headers).get("content-range");
    const [, start, end, size] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
    edit.chunks.push(Buffer.from(body));
    if (Number(end) + 1 < Number(size)) {
      return new Response(null, {
        status: 308,
        headers: { Range: `bytes=0-${end}` },
      });
    }
    if (Number(start) > Number(end)) throw new Error(`Bad range: ${range}`);
    const code = versionCode();
    if (committed().some((upload) => upload.versionCode === code)) {
      record({ refused: "version-code" });
      return refuse(403, `Version code ${code} has already been used.`);
    }
    edit.versionCode = code;
    return json({ versionCode: code });
  }
  if (path.endsWith(":commit")) {
    if (process.env.PROOF_PLAY_FAIL === "commit") {
      record({ refused: "commit" });
      return refuse(400, "The proof's store refuses this commit.");
    }
    const edit = edits.get(editId);
    const artifact = Buffer.concat(edit.chunks);
    record({
      versionCode: edit.versionCode,
      sha256: createHash("sha256").update(artifact).digest("hex"),
      size: artifact.length,
    });
    return json({ id: editId });
  }
  if (path.includes("/tracks/")) {
    if (method === "PUT") return json({ track: "internal" });
    return json({
      track: "internal",
      releases: committed().map((upload) => ({
        versionCodes: [String(upload.versionCode)],
        status: "completed",
      })),
    });
  }
  if (method === "DELETE") {
    edits.delete(editId);
    return new Response(null, { status: 204 });
  }
  return refuse(404, `The proof's store has no ${method} ${path}.`);
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === TOKEN) return json({ access_token: "proof-token" });
  if (url.origin === API) return answer(url, init);
  if (STORES.test(url.hostname)) {
    throw new Error(`The proof reached a real store: ${url.origin}.`);
  }
  return realFetch(input, init);
};
