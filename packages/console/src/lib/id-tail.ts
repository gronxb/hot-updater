/**
 * How much of a release's or an artifact's ID the Console shows: its last 12
 * characters, a UUID's last group. A UUIDv7's head is a timestamp that
 * neighbouring IDs share; the tail tells them apart. Every ID display clips
 * to it, labeled or not, and `IdTails.spec.tsx` fails on any other width.
 */
export const ID_TAIL = 12;

/** An ID's tail as text, for a string such as a filter chip's name. */
export const idTail = (id: string) => id.slice(-ID_TAIL);
