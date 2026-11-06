import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { qrCodePng } from "../../shared/qrCode.mjs";
import { QR_BRANCH, removeQrCodes, writeQrCodes } from "./qrBranch.mjs";
import { fakeGitHub } from "./testing/fakeGitHub";

const LINK =
  "hu-sandbox-com-example-app://hot-updater/preview?channel=pr-12&fingerprint=8681de8b88a8db15b82606b4";
const DOWNLOAD =
  "https://console.internal.example/api/native-builds/019a0000-0000-7000-8000-00000000b001/download";

const name = (value: string) =>
  `${createHash("sha256").update(value).digest("hex").slice(0, 16)}.png`;

const noWait = { sleep: async () => {} };

describe("writeQrCodes", () => {
  it("writes each QR code to the pull request's folder on an orphan branch, named by what it holds", async () => {
    const fake = fakeGitHub();
    const urls = await writeQrCodes(fake.github, 12, [LINK, DOWNLOAD], noWait);

    expect(QR_BRANCH).toBe("hot-updater-preview");
    expect(urls).toEqual({
      [LINK]: `https://github.com/octo/app/raw/hot-updater-preview/pr-12/${name(LINK)}`,
      [DOWNLOAD]: `https://github.com/octo/app/raw/hot-updater-preview/pr-12/${name(DOWNLOAD)}`,
    });
    const files = fake.files()!;
    expect(Object.keys(files).sort()).toEqual(
      ["README.md", `pr-12/${name(LINK)}`, `pr-12/${name(DOWNLOAD)}`].sort(),
    );
    expect(files[`pr-12/${name(LINK)}`]!.equals(qrCodePng(LINK))).toBe(true);
    const head = fake.git.refs.get("heads/hot-updater-preview")!;
    expect(fake.git.commits.get(head)!.parents).toEqual([]);
  });

  it("commits nothing when the folder already holds the same QR codes", async () => {
    const fake = fakeGitHub();
    await writeQrCodes(fake.github, 12, [LINK], noWait);
    fake.calls.length = 0;

    await writeQrCodes(fake.github, 12, [LINK], noWait);

    expect(fake.calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
  });

  it("replaces the pull request's folder and keeps the other pull requests'", async () => {
    const fake = fakeGitHub();
    await writeQrCodes(fake.github, 12, [LINK], noWait);
    await writeQrCodes(fake.github, 13, [LINK], noWait);

    await writeQrCodes(fake.github, 12, [DOWNLOAD], noWait);

    expect(Object.keys(fake.files()!).sort()).toEqual(
      ["README.md", `pr-12/${name(DOWNLOAD)}`, `pr-13/${name(LINK)}`].sort(),
    );
    const head = fake.git.refs.get("heads/hot-updater-preview")!;
    expect(fake.git.commits.get(head)!.parents).toHaveLength(1);
  });

  it("tries again on top of another job's push, keeping both", async () => {
    const fake = fakeGitHub();
    await writeQrCodes(fake.github, 14, [DOWNLOAD], noWait);
    fake.onNextRefWrite((git) =>
      git.push("hot-updater-preview", {
        "pr-13/other.png": Buffer.from("other"),
      }),
    );
    fake.calls.length = 0;

    await writeQrCodes(fake.github, 12, [LINK], noWait);

    expect(Object.keys(fake.files()!).sort()).toEqual(
      [
        "README.md",
        `pr-12/${name(LINK)}`,
        "pr-13/other.png",
        `pr-14/${name(DOWNLOAD)}`,
      ].sort(),
    );
    expect(
      fake.calls.filter((call) => call.startsWith("PATCH /git/refs")),
    ).toHaveLength(2);
  });

  it("tries again when another job created the branch first", async () => {
    const fake = fakeGitHub({
      beforeRefWrite: (git) => {
        const tree = git.putTree(new Map());
        git.refs.set(
          "heads/hot-updater-preview",
          git.putCommit(tree, [], "another job"),
        );
        git.push("hot-updater-preview", {
          "pr-13/other.png": Buffer.from("other"),
        });
      },
    });

    await writeQrCodes(fake.github, 12, [LINK], noWait);

    expect(Object.keys(fake.files()!)).toContain("pr-13/other.png");
    expect(Object.keys(fake.files()!)).toContain(`pr-12/${name(LINK)}`);
  });

  it("names the permission a refused write needs", async () => {
    const fake = fakeGitHub({ refuse: true });

    await expect(writeQrCodes(fake.github, 12, [LINK], noWait)).rejects.toThrow(
      'GitHub answered 403 to POST https://api.github.com/repos/octo/app/git/blobs: give the workflow "permissions: contents: write", and let it create the hot-updater-preview branch.',
    );
  });

  it("links to a GitHub Enterprise Server's own host", async () => {
    const fake = fakeGitHub({
      apiUrl: "https://github.example.com/api/v3",
      serverUrl: "https://github.example.com",
    });

    expect(await writeQrCodes(fake.github, 12, [LINK], noWait)).toEqual({
      [LINK]: `https://github.example.com/octo/app/raw/hot-updater-preview/pr-12/${name(LINK)}`,
    });
  });
});

describe("removeQrCodes", () => {
  it("removes the pull request's folder only", async () => {
    const fake = fakeGitHub();
    await writeQrCodes(fake.github, 12, [LINK], noWait);
    await writeQrCodes(fake.github, 13, [DOWNLOAD], noWait);

    await removeQrCodes(fake.github, 12, noWait);

    expect(Object.keys(fake.files()!).sort()).toEqual(
      ["README.md", `pr-13/${name(DOWNLOAD)}`].sort(),
    );
  });

  it("writes nothing when the branch has no folder of the pull request, or no branch at all", async () => {
    const fake = fakeGitHub();
    await removeQrCodes(fake.github, 12, noWait);
    await writeQrCodes(fake.github, 13, [LINK], noWait);
    fake.calls.length = 0;

    await removeQrCodes(fake.github, 12, noWait);

    expect(fake.calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
    expect(fake.files("missing")).toBeNull();
  });
});
