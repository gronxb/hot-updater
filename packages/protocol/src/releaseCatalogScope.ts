import type { Platform } from "./types";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_CATALOG_SEGMENT_LENGTH = 255;

function assertCatalogSegment(value: string, name: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_CATALOG_SEGMENT_LENGTH ||
    !/^[A-Za-z0-9._~-]+$/.test(value)
  ) {
    throw new Error(
      `${name} must be 1-${MAX_CATALOG_SEGMENT_LENGTH} URL-safe ASCII characters`,
    );
  }
}

function encodeUtf8(value: string): number[] {
  const bytes: number[] = [];
  for (const codePointText of value) {
    const codePoint = codePointText.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function decodeUtf8(bytes: readonly number[]): string {
  let result = "";
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index++]!;
    let codePoint: number;
    let continuationCount: number;

    if (first <= 0x7f) {
      codePoint = first;
      continuationCount = 0;
    } else if ((first & 0xe0) === 0xc0) {
      codePoint = first & 0x1f;
      continuationCount = 1;
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = first & 0x0f;
      continuationCount = 2;
    } else if ((first & 0xf8) === 0xf0) {
      codePoint = first & 0x07;
      continuationCount = 3;
    } else {
      throw new Error("Invalid UTF-8 channel key");
    }

    for (let offset = 0; offset < continuationCount; offset += 1) {
      const continuation = bytes[index++];
      if (continuation === undefined || (continuation & 0xc0) !== 0x80) {
        throw new Error("Invalid UTF-8 channel key");
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    if (
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (continuationCount === 1 && codePoint < 0x80) ||
      (continuationCount === 2 && codePoint < 0x800) ||
      (continuationCount === 3 && codePoint < 0x10000)
    ) {
      throw new Error("Invalid UTF-8 channel key");
    }

    result += String.fromCodePoint(codePoint);
  }
  return result;
}

function base64UrlEncode(bytes: readonly number[]): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    result += BASE64URL_ALPHABET[(value >> 18) & 0x3f];
    result += BASE64URL_ALPHABET[(value >> 12) & 0x3f];
    if (second !== undefined) {
      result += BASE64URL_ALPHABET[(value >> 6) & 0x3f];
    }
    if (third !== undefined) {
      result += BASE64URL_ALPHABET[value & 0x3f];
    }
  }
  return result;
}

function base64UrlDecode(value: string): number[] {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid channel key");
  }

  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const chunk = value.slice(index, index + 4);
    const encoded = [...chunk].map((character) =>
      BASE64URL_ALPHABET.indexOf(character),
    );
    if (encoded.some((part) => part < 0)) {
      throw new Error("Invalid channel key");
    }

    const bits =
      (encoded[0]! << 18) |
      (encoded[1]! << 12) |
      ((encoded[2] ?? 0) << 6) |
      (encoded[3] ?? 0);
    bytes.push((bits >> 16) & 0xff);
    if (chunk.length >= 3) bytes.push((bits >> 8) & 0xff);
    if (chunk.length === 4) bytes.push(bits & 0xff);
  }
  return bytes;
}

export function normalizeChannelName(channel: string): string {
  return channel.trim().normalize("NFC");
}

export function assertCanonicalChannelName(channel: string): void {
  const normalized = normalizeChannelName(channel);
  if (normalized.length === 0 || normalized !== channel) {
    throw new Error(
      "Channel name must be non-empty, trimmed, and NFC-normalized",
    );
  }

  let codePointCount = 0;
  for (const _codePoint of normalized) {
    codePointCount += 1;
    if (codePointCount > 255) {
      throw new Error("Channel name must not exceed 255 characters");
    }
  }
}

export function encodeChannelKey(channel: string): string {
  assertCanonicalChannelName(channel);
  return base64UrlEncode(encodeUtf8(channel));
}

export function decodeChannelKey(channelKey: string): string {
  const channel = decodeUtf8(base64UrlDecode(channelKey));
  assertCanonicalChannelName(channel);
  if (encodeChannelKey(channel) !== channelKey) {
    throw new Error("Channel key is not canonically encoded");
  }
  return channel;
}

export type ReleaseCatalogScopeKeyInput = {
  readonly platform: Platform;
  readonly channelKey: string;
} & (
  | {
      readonly strategy: "APP_VERSION";
      readonly fingerprintHash?: never;
    }
  | {
      readonly strategy: "FINGERPRINT";
      readonly fingerprintHash: string;
    }
);

export function createReleaseCatalogScopeKey(
  input: ReleaseCatalogScopeKeyInput,
): string {
  decodeChannelKey(input.channelKey);

  if (input.strategy === "APP_VERSION") {
    return `v1:app-version:${input.platform}:${input.channelKey}`;
  }

  assertCatalogSegment(input.fingerprintHash, "Fingerprint hash");
  return `v1:fingerprint:${input.platform}:${input.channelKey}:${input.fingerprintHash}`;
}

export function parseReleaseCatalogScopeKey(
  scopeKey: string,
): ReleaseCatalogScopeKeyInput {
  const segments = scopeKey.split(":");
  const [version, strategy, platform, channelKey] = segments;
  if (
    version !== "v1" ||
    (platform !== "ios" && platform !== "android") ||
    channelKey === undefined
  ) {
    throw new Error("Invalid release catalog scope key");
  }

  const input: ReleaseCatalogScopeKeyInput =
    strategy === "app-version" && segments.length === 4
      ? {
          channelKey,
          platform,
          strategy: "APP_VERSION",
        }
      : strategy === "fingerprint" &&
          segments.length === 5 &&
          segments[4] !== undefined
        ? {
            channelKey,
            fingerprintHash: segments[4],
            platform,
            strategy: "FINGERPRINT",
          }
        : (() => {
            throw new Error("Invalid release catalog scope key");
          })();

  if (createReleaseCatalogScopeKey(input) !== scopeKey) {
    throw new Error("Release catalog scope key is not canonical");
  }
  return input;
}
