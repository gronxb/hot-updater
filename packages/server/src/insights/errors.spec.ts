import { describe, expect, it } from "vitest";

import {
  DatabaseConflictError,
  DatabaseTransactionError,
} from "../database/errors";
import { isDatabaseBusyError } from "./errors";

const failure = (message: string, fields: object) =>
  Object.assign(new Error(message), fields);

describe("isDatabaseBusyError", () => {
  it.each([
    [
      "a transaction out of retries",
      new DatabaseConflictError("The transaction conflicted 8 times."),
    ],
    [
      "a throttled DynamoDB read",
      failure("Throughput exceeds the current capacity of your table.", {
        name: "ProvisionedThroughputExceededException",
      }),
    ],
    ["an HTTP 429", failure("Too Many Requests", { status: 429 })],
    [
      "an AWS SDK 429",
      failure("Too Many Requests", { $metadata: { httpStatusCode: 429 } }),
    ],
    [
      "Firestore's RESOURCE_EXHAUSTED",
      failure("8 RESOURCE_EXHAUSTED: Quota exceeded.", { code: 8 }),
    ],
  ])("holds for %s", (_case, error) => {
    expect(isDatabaseBusyError(error)).toBe(true);
  });

  it.each([
    ["a gauge below zero", new DatabaseTransactionError("gauge below zero")],
    ["MongoDB's unknown error, also code 8", failure("unknown", { code: 8 })],
    [
      "a refused connection",
      failure("connect ECONNREFUSED", { code: "ECONNREFUSED" }),
    ],
    ["a thrown string", "busy"],
  ])("does not hold for %s", (_case, error) => {
    expect(isDatabaseBusyError(error)).toBe(false);
  });
});
