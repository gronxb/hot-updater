import { describe, expect, it } from "vitest";

import {
  handleEnqueuePendingE2eAction,
  readPendingE2eAction,
  resetPendingE2eAction,
  takePendingE2eAction,
} from "./pending-action.ts";

describe("pending E2E action queue", () => {
  it("lets a poller peek without consuming the queued action", () => {
    resetPendingE2eAction();
    handleEnqueuePendingE2eAction({
      testID: "action-install-current-channel-update",
    });
    expect(readPendingE2eAction()).toEqual({
      testID: "action-install-current-channel-update",
    });
    expect(readPendingE2eAction()).toEqual({
      testID: "action-install-current-channel-update",
    });
    expect(takePendingE2eAction()).toEqual({
      testID: "action-install-current-channel-update",
    });
    expect(readPendingE2eAction()).toBeNull();
    expect(takePendingE2eAction()).toBeNull();
  });
});
