import crypto from "node:crypto";

/**
 * Apple's sign-in proof: SRP-6a over the RFC 5054 2048-bit group with
 * SHA-256, the password stretched with PBKDF2, as Apple's sign-in page and
 * asc, the open-source App Store Connect CLI
 * (https://github.com/rorkai/App-Store-Connect-CLI, MIT), compute it.
 */

/** RFC 5054, Appendix A, the 2048-bit group. */
const N = BigInt(
  "0xAC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73",
);
const G = 2n;
/** The hex length every padded value has: N's byte length, twice. */
const PADDED_HEX_LENGTH = 512;

const modPow = (base: bigint, exponent: bigint, modulus: bigint) => {
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
};

/** An even-length lowercase hex of `value`, as the proof hashes it. */
const toHex = (value: bigint) => {
  const hex = value.toString(16);
  return hex.length % 2 === 1 ? `0${hex}` : hex;
};

const fromBytes = (bytes: Uint8Array) =>
  bytes.length === 0 ? 0n : BigInt(`0x${Buffer.from(bytes).toString("hex")}`);

const sha256Hex = (hex: string) =>
  crypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");

/** SHA-256 of each value left-padded to N's length, as a number mod N. */
const paddedHash = (...values: readonly string[]) =>
  BigInt(
    `0x${sha256Hex(values.map((value) => value.padStart(PADDED_HEX_LENGTH, "0")).join(""))}`,
  ) % N;

/** The password as the protocol Apple named feeds it to PBKDF2. */
const preparePassword = (password: string, protocol: string) => {
  const digest = crypto.createHash("sha256").update(password).digest();
  if (protocol === "s2k") return digest;
  if (protocol === "s2k_fo") return Buffer.from(digest.toString("hex"));
  throw new Error(`Apple asked for the sign-in protocol ${protocol}.`);
};

export interface SrpClient {
  /** The client's public value A, base64, for `signin/init`. */
  readonly a: string;
  /**
   * The proofs M1 and M2, base64, for `signin/complete`, from what
   * `signin/init` answered.
   */
  proof(input: {
    readonly accountName: string;
    readonly password: string;
    readonly protocol: string;
    readonly iterations: number;
    /** base64 */
    readonly salt: string;
    /** The server's public value B, base64. */
    readonly b: string;
  }): { readonly m1: string; readonly m2: string };
}

/** A new SRP client; `secret` is the private value a, random unless set. */
export const createSrpClient = (
  secret: bigint = fromBytes(crypto.randomBytes(256)),
): SrpClient => {
  const A = modPow(G, secret, N);
  const aHex = toHex(A);
  return {
    a: Buffer.from(aHex, "hex").toString("base64"),
    proof: ({ accountName, password, protocol, iterations, salt, b }) => {
      const saltBytes = Buffer.from(salt, "base64");
      const saltHex = saltBytes.toString("hex");
      const bHex = Buffer.from(b, "base64").toString("hex");
      const B = BigInt(`0x${bHex || "0"}`);
      if (B % N === 0n) throw new Error("Apple answered an invalid SRP value.");
      const derived = crypto.pbkdf2Sync(
        preparePassword(password, protocol),
        saltBytes,
        iterations,
        32,
        "sha256",
      );
      const x = BigInt(
        `0x${sha256Hex(saltHex + sha256Hex(`3a${derived.toString("hex")}`))}`,
      );
      const k = paddedHash(toHex(N), toHex(G));
      const u = paddedHash(aHex, bHex);
      if (u === 0n) throw new Error("Apple answered an invalid SRP value.");
      const S = modPow(B - ((k * modPow(G, x, N)) % N), secret + u * x, N);
      const K = sha256Hex(toHex(S));
      const m1 = sha256Hex(
        toHex(paddedHash(toHex(N)) ^ paddedHash(toHex(G))) +
          crypto.createHash("sha256").update(accountName).digest("hex") +
          saltHex +
          aHex +
          bHex +
          K,
      );
      const m2 = toHex(BigInt(`0x${sha256Hex(aHex + m1 + K)}`));
      return {
        m1: Buffer.from(m1, "hex").toString("base64"),
        m2: Buffer.from(m2, "hex").toString("base64"),
      };
    },
  };
};

const hasLeadingZeroBits = (digest: Buffer, bits: number) => {
  const full = Math.floor(bits / 8);
  for (let index = 0; index < full; index++) {
    if (digest[index] !== 0) return false;
  }
  const rest = bits % 8;
  return rest === 0 || (digest[full]! & (0xff << (8 - rest)) & 0xff) === 0;
};

/**
 * The hashcash stamp Apple's sign-in asks for in `X-Apple-HC`: the first
 * `1:<bits>:<date>:<challenge>::<counter>` whose SHA-1 starts with `bits`
 * zero bits.
 */
export const makeHashcash = (
  bits: number,
  challenge: string,
  now: Date = new Date(),
) => {
  const date = now
    .toISOString()
    .replace(/\.\d+Z$/u, "")
    .replaceAll(/[-:T]/gu, "");
  for (let counter = 0; ; counter++) {
    const stamp = `1:${bits}:${date}:${challenge}::${counter}`;
    const digest = crypto.createHash("sha1").update(stamp).digest();
    if (hasLeadingZeroBits(digest, bits)) return stamp;
  }
};
