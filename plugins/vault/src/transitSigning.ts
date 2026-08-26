import { createPublicKey, verify } from "node:crypto";

import type { BundleSigningPlugin } from "@hot-updater/plugin-core";

const RESPONSE_BODY_LIMIT = 64 * 1024;

export interface TransitSigningOptions {
  /** Vault or OpenBao server URL. Defaults to VAULT_ADDR or BAO_ADDR. */
  readonly address?: string;
  /** Transit signing key name. */
  readonly keyName: string;
  /** Pinned positive Transit key version. */
  readonly keyVersion: number;
  /** Transit secrets engine mount path. Defaults to "transit". */
  readonly mountPath?: string;
  /** Vault Enterprise namespace. Defaults to VAULT_NAMESPACE. */
  readonly namespace?: string;
  /** Checked-in RSA SPKI public key used as the native trust anchor. */
  readonly publicKeyPath: string;
  /** Vault or OpenBao token. Defaults to VAULT_TOKEN or BAO_TOKEN. */
  readonly token?: string;
}

interface ResolvedKey {
  publicKey: string;
}

interface ResolvedConnection {
  headers: Record<string, string>;
  keyUrl: string;
  signUrl: string;
}

const invalidPublicKeyResponse = () =>
  new Error("Vault Transit returned an invalid signing public key response.");

const unsupportedSigningKey = () =>
  new Error("Vault Transit key does not support RSA-SHA256 bundle signing.");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const normalizeAddress = (address: string) => {
  try {
    const url = new URL(address);
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid URL");
    }
    return url.href.replace(/\/$/u, "");
  } catch {
    throw new Error("Vault Transit signing requires a valid server address.");
  }
};

const normalizeMountPath = (mountPath: string) => {
  const normalized = mountPath.replace(/^\/+|\/+$/gu, "");
  if (
    !normalized ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Vault Transit signing requires a valid mount path.");
  }
  return normalized
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readResponseJson = async (response: Response): Promise<unknown> => {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > RESPONSE_BODY_LIMIT)
  ) {
    throw new Error("response too large");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_BODY_LIMIT) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
};

const readPublicKey = (
  response: unknown,
  keyName: string,
  keyVersion: number,
) => {
  if (!isRecord(response) || !isRecord(response.data)) {
    throw invalidPublicKeyResponse();
  }
  const { data } = response;
  if (data.name !== keyName || !isRecord(data.keys)) {
    throw invalidPublicKeyResponse();
  }
  if (
    data.supports_signing !== true ||
    !["rsa-2048", "rsa-3072", "rsa-4096"].includes(String(data.type))
  ) {
    throw unsupportedSigningKey();
  }

  const version = data.keys[String(keyVersion)];
  if (!isRecord(version) || typeof version.public_key !== "string") {
    throw invalidPublicKeyResponse();
  }

  try {
    const normalizedPublicKey = version.public_key.trim();
    if (
      !normalizedPublicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
      !normalizedPublicKey.endsWith("-----END PUBLIC KEY-----")
    ) {
      throw new Error("not spki");
    }
    const key = createPublicKey(normalizedPublicKey);
    if (key.asymmetricKeyType !== "rsa") {
      throw new Error("not rsa");
    }
    return key.export({ format: "pem", type: "spki" }).toString();
  } catch {
    throw invalidPublicKeyResponse();
  }
};

const readSignature = (response: unknown, keyVersion: number) => {
  if (
    !isRecord(response) ||
    !isRecord(response.data) ||
    typeof response.data.signature !== "string"
  ) {
    throw new Error("Vault Transit returned an invalid signing response.");
  }

  const match = /^vault:v(\d+):([A-Za-z0-9+/_=-]+)$/u.exec(
    response.data.signature,
  );
  if (!match || Number(match[1]) !== keyVersion) {
    throw new Error("Vault Transit returned an invalid signing response.");
  }
  const signature = Buffer.from(match[2]!, "base64");
  if (signature.byteLength === 0) {
    throw new Error("Vault Transit returned an invalid signing response.");
  }
  return signature;
};

/** Creates a bundle signer backed by Vault or OpenBao Transit. */
export const transitSigning = ({
  address,
  keyName,
  keyVersion,
  mountPath = "transit",
  namespace,
  publicKeyPath,
  token,
}: TransitSigningOptions): BundleSigningPlugin => {
  const configuredAddress =
    address === undefined ? undefined : normalizeAddress(address);
  const normalizedMountPath = normalizeMountPath(mountPath);
  if (!keyName.trim()) {
    throw new Error("Vault Transit signing key name is required.");
  }
  if (keyName.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(
      "Vault Transit signing key name must not contain dot path segments.",
    );
  }
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error("Vault Transit signing requires a pinned key version.");
  }
  if (!publicKeyPath.trim()) {
    throw new Error("Vault Transit signing public key path is required.");
  }
  if (token !== undefined && !token.trim()) {
    throw new Error("Vault Transit signing token is required.");
  }

  const keyPath = encodeURIComponent(keyName);
  let resolvedConnection: ResolvedConnection | undefined;
  const getConnection = () => {
    if (resolvedConnection) return resolvedConnection;

    const normalizedAddress =
      configuredAddress ??
      normalizeAddress(process.env.VAULT_ADDR ?? process.env.BAO_ADDR ?? "");
    const resolvedToken =
      token ?? process.env.VAULT_TOKEN ?? process.env.BAO_TOKEN ?? "";
    if (!resolvedToken.trim()) {
      throw new Error("Vault Transit signing token is required.");
    }
    const resolvedNamespace = namespace ?? process.env.VAULT_NAMESPACE;
    resolvedConnection = {
      headers: {
        "Content-Type": "application/json",
        "X-Vault-Token": resolvedToken,
        ...(resolvedNamespace
          ? { "X-Vault-Namespace": resolvedNamespace }
          : {}),
      },
      keyUrl: `${normalizedAddress}/v1/${normalizedMountPath}/keys/${keyPath}`,
      signUrl: `${normalizedAddress}/v1/${normalizedMountPath}/sign/${keyPath}/sha2-256`,
    };
    return resolvedConnection;
  };
  let resolvedKey: Promise<ResolvedKey> | undefined;

  const request = async (url: string, init?: RequestInit) => {
    const { headers } = getConnection();
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Vault Transit request failed.");
    }
    if (!response.ok) {
      throw new Error("Vault Transit request failed.");
    }
    try {
      return await readResponseJson(response);
    } catch {
      throw new Error("Vault Transit returned an invalid JSON response.");
    }
  };

  const getResolvedKey = () => {
    if (resolvedKey) return resolvedKey;
    resolvedKey = Promise.resolve()
      .then(() => request(getConnection().keyUrl))
      .then((response) => ({
        publicKey: readPublicKey(response, keyName, keyVersion),
      }))
      .catch((error) => {
        resolvedKey = undefined;
        if (
          error instanceof Error &&
          (error.message === invalidPublicKeyResponse().message ||
            error.message === unsupportedSigningKey().message)
        ) {
          throw error;
        }
        throw new Error("Failed to load the Vault Transit signing public key.");
      });
    return resolvedKey;
  };

  return {
    name: "transitSigning",
    publicKeyPath,
    async getPublicKey() {
      return getResolvedKey();
    },
    async sign({ message }) {
      if (!(message instanceof Uint8Array) || message.byteLength !== 32) {
        throw new Error(
          "Vault Transit signing messages must be exactly 32 bytes.",
        );
      }

      const { publicKey } = await getResolvedKey();
      let response: unknown;
      try {
        response = await request(getConnection().signUrl, {
          body: JSON.stringify({
            input: Buffer.from(message).toString("base64"),
            key_version: keyVersion,
            prehashed: false,
            signature_algorithm: "pkcs1v15",
          }),
          method: "POST",
        });
      } catch {
        throw new Error("Vault Transit failed to sign the bundle message.");
      }
      const signature = readSignature(response, keyVersion);
      if (!verify("RSA-SHA256", message, publicKey, signature)) {
        throw new Error(
          "Vault Transit returned an unverifiable bundle signature.",
        );
      }
      return { signature };
    },
  };
};
