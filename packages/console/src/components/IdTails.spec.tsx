import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { Bundle } from "@hot-updater/plugin-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { bundleChip } from "@/lib/release-adoption";

import { ArtifactIdDisplay } from "./ArtifactIdDisplay";
import { BundleChildrenPanel } from "./features/bundles/BundleChildrenPanel";
import {
  EventBundleTransition,
  HttpResponseDetails,
} from "./features/insights/EventDetails";
import { InstallationMatchesCard } from "./features/insights/InstallationMatchesCard";
import { ReleaseIdDisplay } from "./ReleaseIdDisplay";

/*
 * The Console shows every release, artifact, and install ID the same way:
 * the whole ID in the text, clipped from the left to its last 12 characters (the
 * timestamp head is what neighbouring IDs share), or from the right to its
 * first 12 for a built-in bundle ID whose tail is zeros, with the full ID in a
 * popover or a title. This guard renders the surfaces that show IDs and
 * scans the source for the ways an ID was shown before, so a new surface
 * that shows a shorter tail, a head-and-tail pill, or the full ID fails here.
 */

const TAIL = 12;
const RELEASE = "019f6a12-3b4c-7d5e-8f60-71a2b3c4d5e6";
const OTHER_RELEASE = "019f6a15-7f3e-7b2d-9c1a-0e9d8c7b6a5f";
const ARTIFACT = "019f6a13-9e8d-7c6b-a5f4-e3d2c1b0a9f8";
const PATCH_ARTIFACT = "019f6a14-2468-7ace-9bdf-13579bdf2468";
const BUILT_IN = "019f6a10-5a5a-7b6b-8c7c-d8d8e9e9fafa";
// A built-in bundle's ID as a native build makes it: its build time, then
// zero random bits, so its last 12 characters are zeros in every build.
const ZERO_TAIL = "019f6a0e-77c1-7000-8000-000000000000";
const NIL = "00000000-0000-0000-0000-000000000000";
// An earlier CLI's built-in bundle ID: a platform byte, then random bits.
const PLATFORM_BYTE = "019f6a0f-1b2c-7000-8000-01c4d2e8a7f3";
// An installation's ID: a UUIDv4 the app creates, not a release's or an
// artifact's, shown the same way.
const INSTALL = "8d2f0c1e-4b7a-4e6d-9f3c-2a1b0c9d8e7f";
const IDS = [
  RELEASE,
  OTHER_RELEASE,
  ARTIFACT,
  PATCH_ARTIFACT,
  BUILT_IN,
  ZERO_TAIL,
  PLATFORM_BYTE,
  INSTALL,
];

/** The IDs whose last 12 characters tell nothing apart: their head shows. */
const HEADS = new Set([ZERO_TAIL]);

afterEach(cleanup);

/** Whether a text shows any recognisable piece of `id`. */
const showsPartOf = (text: string, id: string) =>
  text.includes(id.slice(0, 8)) || text.includes(id.slice(-4));

/**
 * Fails unless every visible text that shows part of an ID is that whole ID,
 * clipped to 12 characters: its last 12, or its first 12 for a built-in
 * bundle ID whose tail is zeros. Screen-reader text and popovers, which
 * hold the full ID on purpose, are left out.
 */
function expectTailsOnly(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const element = node.parentElement!;
    if (element.closest(".sr-only, [role=tooltip]")) continue;
    for (const id of IDS) {
      if (!showsPartOf(text, id)) continue;
      seen.push(id);
      // The whole ID, never a head…tail pill or a slice of it.
      expect(text, `shown as "${text}"`).toBe(id);
      const clip = element.closest("[class*='ch]']");
      expect(clip, `${id} shows in full`).not.toBeNull();
      expect(clip!.className).toContain(`w-[${TAIL}ch]`);
      expect(clip!.className).toContain("overflow-hidden");
      // A tail overflows to the left, a head to the right.
      expect(clip!.className, `${id}'s clip`).toContain(
        HEADS.has(id) ? "justify-start" : "justify-end",
      );
    }
  }
  // Nothing renders a clip of any other width.
  for (const element of root.querySelectorAll("[class*='ch]']")) {
    for (const width of element.className.match(/w-\[[\d.]+ch\]/g) ?? []) {
      expect(width).toBe(`w-[${TAIL}ch]`);
    }
  }
  return seen;
}

const renderTails = (ui: ReactElement) => {
  const { container } = render(ui);
  return expectTailsOnly(container);
};

describe("every release and artifact ID shows its last 12 characters", () => {
  it("in each form of a release's display, labeled or not", () => {
    const opener = <button type="button" />;
    for (const label of [14, null, undefined]) {
      for (const copyable of [true, false]) {
        for (const part of [undefined, "id"] as const) {
          for (const labelAs of [undefined, opener]) {
            const seen = renderTails(
              <ReleaseIdDisplay
                copyable={copyable}
                label={label}
                labelAs={labelAs}
                part={part}
                platform="ios"
                releaseId={RELEASE}
              />,
            );
            expect(seen).toContain(RELEASE);
            cleanup();
          }
        }
      }
    }
  });

  it("in an artifact's display, inside a control or not", () => {
    expect(renderTails(<ArtifactIdDisplay artifactId={ARTIFACT} />)).toEqual([
      ARTIFACT,
    ]);
  });

  it("in the patch artifacts from a base, with and without the release serving them", () => {
    const base = { id: ARTIFACT } as Bundle;
    const patch = { id: PATCH_ARTIFACT } as Bundle;
    const seen = renderTails(
      <BundleChildrenPanel
        bundle={base}
        bundles={[patch]}
        loading={false}
        onDetailClick={() => {}}
        panelId="panel"
        releaseOf={(id) => (id === ARTIFACT ? { id: RELEASE, label: 3 } : null)}
      />,
    );
    expect(seen).toEqual(
      expect.arrayContaining([ARTIFACT, PATCH_ARTIFACT, RELEASE]),
    );
  });

  it("in an event's bundles, by release or by the bundle it reports", () => {
    const seen = renderTails(
      <>
        <EventBundleTransition
          event={{
            type: "UPDATE_APPLIED",
            fromBundleId: ARTIFACT,
            fromReleaseId: RELEASE,
            toBundleId: PATCH_ARTIFACT,
            toReleaseId: OTHER_RELEASE,
            minBundleId: BUILT_IN,
          }}
        />
        <EventBundleTransition
          event={{
            type: "RECOVERED",
            fromBundleId: ARTIFACT,
            fromReleaseId: RELEASE,
            toBundleId: BUILT_IN,
            toReleaseId: undefined,
            minBundleId: BUILT_IN,
          }}
        />
      </>,
    );
    expect(seen).toEqual(
      expect.arrayContaining([RELEASE, OTHER_RELEASE, BUILT_IN]),
    );
  });

  it("from its head for a built-in bundle ID whose tail is zeros", () => {
    // Every native build's built-in bundle ID ends in the same 12 zeros, so
    // its tail tells none apart: the build-time head does.
    for (const id of [ZERO_TAIL, PLATFORM_BYTE, RELEASE]) {
      for (const copyable of [true, false]) {
        renderTails(<ArtifactIdDisplay artifactId={id} copyable={copyable} />);
        cleanup();
        renderTails(
          <ReleaseIdDisplay copyable={copyable} label={3} releaseId={id} />,
        );
        cleanup();
      }
    }
    const seen = renderTails(
      <EventBundleTransition
        event={{
          type: "RECOVERED",
          fromBundleId: ARTIFACT,
          fromReleaseId: RELEASE,
          toBundleId: ZERO_TAIL,
          toReleaseId: undefined,
          minBundleId: ZERO_TAIL,
        }}
      />,
    );
    expect(seen).toContain(ZERO_TAIL);
    expect(bundleChip(ZERO_TAIL, [])).toBe(
      `Bundle ${ZERO_TAIL.slice(0, TAIL)}`,
    );
    // A debug build's nil UUID is zeros at both ends: it keeps its tail.
    expect(bundleChip(NIL, [])).toBe("Bundle 000000000000");
    expect(bundleChip(PLATFORM_BYTE, [])).toBe(
      `Bundle ${PLATFORM_BYTE.slice(-TAIL)}`,
    );
  });

  it("in the installations a search matches", () => {
    const row = {
      installId: INSTALL,
      userId: "kim",
      lastKnownReleaseId: RELEASE,
      lastKnownBundleId: ARTIFACT,
    };
    const { container } = render(
      <InstallationMatchesCard
        error={null}
        onNext={() => {}}
        onPrevious={() => {}}
        onSelect={() => {}}
        pageNumber={1}
        results={{ data: [row as never], nextCursor: null }}
        selectedInstallId={undefined}
      />,
    );
    const toggle = screen.queryByRole("button", { expanded: false });
    if (toggle) fireEvent.click(toggle);
    expect(expectTailsOnly(container)).toEqual(
      expect.arrayContaining([INSTALL, RELEASE]),
    );
  });

  it("in an HTTP response's context", async () => {
    render(
      <HttpResponseDetails
        event={{
          platform: "ios",
          appVersion: "1.6.0",
          channel: "production",
          installId: INSTALL,
          httpResponse: {
            resource: "catalog",
            path: "/catalog",
            status: 503,
            body: "",
            bodyTruncated: false,
            receivedAtMs: Date.UTC(2026, 9, 3),
          },
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "View catalog response: HTTP 503" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "HTTP response" });
    const context = within(dialog).getByRole("region", {
      name: "Response context",
    });
    expect(expectTailsOnly(context)).toContain(INSTALL);
  });

  it("in a filter chip's text", () => {
    const tail = RELEASE.slice(-TAIL);
    expect(bundleChip(RELEASE, [{ releaseId: RELEASE, label: 7 }])).toBe(
      `Bundle v7 ${tail}`,
    );
    expect(bundleChip(RELEASE, [])).toBe(`Bundle ${tail}`);
  });
});

describe("no surface shows an ID another way", () => {
  const root = join(__dirname, "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
        ? [path]
        : [];
    });
  const files = sources(root).map((path) => ({
    file: relative(root, path),
    text: readFileSync(path, "utf8"),
  }));

  it("clips no ID to a width other than 12 characters", () => {
    const widths = files.flatMap(({ file, text }) =>
      [...text.matchAll(/w-\[([\d.]+)ch\]/g)]
        .filter((match) => match[1] !== String(TAIL))
        .map((match) => `${file}: ${match[0]}`),
    );
    expect(widths).toEqual([]);
  });

  it("renders no release, artifact, or install ID as bare text", () => {
    // `{release.bundle_id}`, `{build.min_bundle_id}`, `{event.installId}`…
    // as a JSX child, or as the value of a labeled `["Installation", …]`
    // row: only the ID displays print an ID themselves.
    const bare =
      /[>}]\s*\{\s*[\w.!?]*(?:[rR]elease_?[iI]d|[bB]undle_?[iI]d|[aA]rtifact_?[iI]d|[iI]nstall_?[iI]d)(?:\s*\?\?\s*"[^"]*")?\s*\}\s*<|\[\s*"[A-Z][^"]*",\s*[\w.!?]*(?:[rR]elease_?[iI]d|[bB]undle_?[iI]d|[aA]rtifact_?[iI]d|[iI]nstall_?[iI]d)\s*\]/g;
    const found = files
      .filter(
        ({ file }) =>
          !/components\/(ReleaseIdDisplay|ArtifactIdDisplay|InstallIdDisplay|IdTail)\.tsx$/.test(
            file,
          ),
      )
      .flatMap(({ file, text }) =>
        [...text.matchAll(bare)].map(
          (match) => `${file}: ${match[0].replace(/\s+/g, " ")}`,
        ),
      );
    expect(found).toEqual([]);
  });

  it("shows only content hashes as a shortened pill", () => {
    // `HashValueDisplay` shows a head…tail pill: for content hashes (a
    // fingerprint, a build key, a manifest), never an ID.
    const pills = files.flatMap(({ file, text }) =>
      [...text.matchAll(/<HashValueDisplay\b[^>]*?\bvalue=\{([^}]+)\}/g)]
        .map((match) => match[1]!.trim())
        .filter((value) => !/[hH]ash|^value$/.test(value))
        .map((value) => `${file}: value={${value}}`),
    );
    const shortened = files.flatMap(({ file, text }) =>
      [...text.matchAll(/shortenIdentifier\(([^)]*)\)/g)]
        .map((match) => match[1]!.trim())
        // The pill's own call, on what its callers above pass it.
        .filter((value) => !(file.endsWith("HashValueDisplay.tsx") && value))
        .filter((value) => value && !/[hH]ash/.test(value))
        .map((value) => `${file}: shortenIdentifier(${value})`),
    );
    expect([...pills, ...shortened]).toEqual([]);
  });
});
