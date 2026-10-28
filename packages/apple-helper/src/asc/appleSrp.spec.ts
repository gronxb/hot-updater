import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { createSrpClient, makeHashcash } from "./appleSrp";

// The expected values come from asc 5.16.1's own code
// (internal/web/auth.go calculateSRPProof and makeHashcash, with
// github.com/1Password/srp's RFC 5054 2048-bit group), run on the same
// fixed inputs: an oracle independent of this implementation.
const secret = BigInt(`0x${"1f".repeat(256)}`);
const A =
  "CkilLkI6AdBNLhhlNMgX/IX1pBUjFbU4q/s6Wr4ZSUdWZ+GJWMLeXZTeEW4ascqhcvqR0eHjSKC7tRAaYeWNRi+dma6vpYTpjg6oQNTxJ8W46dbC3m9d6VLaOF53ZZkmmB7BSd5cEimEqQcci953++EPZ4XD5hzpgffU4Sasnv3Z5trSAK5q9YquhklMd5lG5KblLMr5ZjOtMYuTpkqjiaXXRCLB6cWVUnSx8oesacDa9jnuOku++cM/JUMvbpaGH6X8asO+7VGmM9uVwUv/gZdRmfBE21RogGXYF4qnQ0x4DSjQiwI5BmZsj4RV4b9VOobXd348iXuRZVyXUIVR8A==";
const B =
  "QpG3BS9PGK13u8ExEduhwfnZvXHqVFtJelQwP/Zk8tCCcJAXmmKBsCbXb3jRhRdLcXhjEO8iL6whkVBMAM5vIukCW5XrAUCA6eIYjOfypq64eULG5yTtCh4vqmhwAqeUG/Bp7EeM60MukiB9PdyuUZx1wTMM6WOzqgIUkVc7WKN/fQW82AyIt5wrrk9SQG4vmphPNWbeEqhAUDEUi/KC9tUBErLqIz5IRwSW92osa53M+xYNZmhP6jdh20X5BjTwjDRsBeLkz3cOs2wy6sJQhOm9sJxdY6S658jN7jUwEvkAGZh6AiSku3KQgsLsXpV0l3OPyt1SaqXW1BY9EpHe/g==";
const input = {
  accountName: "dev@example.com",
  password: "correct horse battery staple",
  iterations: 1000,
  salt: Buffer.from("00112233445566778899aabbccddeeff", "hex").toString(
    "base64",
  ),
  b: B,
};

describe("createSrpClient", () => {
  it("sends A as Apple's sign-in page computes it", () => {
    expect(createSrpClient(secret).a).toBe(A);
  });

  it("proves the password with the s2k protocol", () => {
    expect(
      createSrpClient(secret).proof({ ...input, protocol: "s2k" }),
    ).toEqual({
      m1: "iiLneVyE3lcxN0gN5a5KiDgrV5buMzAhWTEvN5Yz66E=",
      m2: "v8U2TVj0XdYExbngoNF5147X3Mlz239MhXm9RUPlPjI=",
    });
  });

  it("proves the password with the s2k_fo protocol", () => {
    expect(
      createSrpClient(secret).proof({ ...input, protocol: "s2k_fo" }),
    ).toEqual({
      m1: "NfsCUUV1qHJRf+gbvBaRE6UllHMwWviExGGVJsp07dM=",
      m2: "zJVKdkLHt5KUtIwM1SrzeqlOf4fX6MdpqQdzqiRbYrM=",
    });
  });

  it("proves another password differently", () => {
    expect(
      createSrpClient(secret).proof({
        ...input,
        password: "wrong",
        protocol: "s2k",
      }).m1,
    ).not.toBe("iiLneVyE3lcxN0gN5a5KiDgrV5buMzAhWTEvN5Yz66E=");
  });

  it("refuses a protocol it doesn't know", () => {
    expect(() =>
      createSrpClient(secret).proof({ ...input, protocol: "s2k_v3" }),
    ).toThrow("Apple asked for the sign-in protocol s2k_v3.");
  });

  it("refuses a server value of zero", () => {
    expect(() =>
      createSrpClient(secret).proof({
        ...input,
        protocol: "s2k",
        b: Buffer.alloc(256).toString("base64"),
      }),
    ).toThrow("Apple answered an invalid SRP value.");
  });

  it("picks a new private value each time", () => {
    expect(createSrpClient().a).not.toBe(createSrpClient().a);
  });
});

describe("makeHashcash", () => {
  it("finds the stamp asc finds", () => {
    expect(
      makeHashcash(
        11,
        "4d74fb15eb23f465f1f6fcbf534e5877",
        new Date(Date.UTC(2026, 9, 28, 1, 2, 3)),
      ),
    ).toBe("1:11:20261028010203:4d74fb15eb23f465f1f6fcbf534e5877::357");
  });

  it("finds a stamp whose SHA-1 starts with the bits asked for", () => {
    const stamp = makeHashcash(16, "challenge");
    const digest = crypto.createHash("sha1").update(stamp).digest();
    expect(digest.readUInt16BE(0)).toBe(0);
  });
});
