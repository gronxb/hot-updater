import { isBuiltinBundleId } from "./builtin-bundle-id";

/**
 * How much of a release's or an artifact's ID the Console shows: the 12
 * characters that tell IDs apart. That is its last 12, a UUID's last group:
 * a UUIDv7's head is a timestamp that neighbouring IDs share, and the tail
 * tells them apart. A built-in bundle ID's tail is zeros in every native
 * build, so it shows its first 12, its build time, instead. Every ID display
 * clips to it, labeled or not, and `IdTails.spec.tsx` fails on any other
 * width.
 */
export const ID_TAIL = 12;

const ZERO_TAIL = "0".repeat(ID_TAIL);

/**
 * Which end of an ID the Console shows: the head for a built-in bundle ID
 * whose last 12 characters are zeros, the tail for every other ID. A debug
 * build's nil UUID is zeros at both ends, so it keeps its tail.
 */
export const idEnd = (id: string): "head" | "tail" =>
  id.endsWith(ZERO_TAIL) &&
  isBuiltinBundleId(id) &&
  /[1-9a-f]/iu.test(id.slice(0, ID_TAIL))
    ? "head"
    : "tail";

/** The 12 characters an ID shows as text, for a string such as a filter chip's name. */
export const idTail = (id: string) =>
  idEnd(id) === "head" ? id.slice(0, ID_TAIL) : id.slice(-ID_TAIL);
