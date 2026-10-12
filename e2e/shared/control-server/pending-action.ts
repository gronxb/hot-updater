export type PendingE2eAction = {
  readonly testID: string;
  readonly text?: string;
};

let pendingAction: PendingE2eAction | null = null;

export const readPendingE2eAction = () => pendingAction;

export const takePendingE2eAction = () => {
  const action = pendingAction;
  pendingAction = null;
  return action;
};

export const handleEnqueuePendingE2eAction = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("pending action payload must be an object");
  }
  const testID = (payload as { testID?: unknown }).testID;
  const text = (payload as { text?: unknown }).text;
  if (typeof testID !== "string" || testID.length === 0) {
    throw new Error("pending action testID is required");
  }
  if (text !== undefined && typeof text !== "string") {
    throw new Error("pending action text must be a string");
  }
  pendingAction = text === undefined ? { testID } : { testID, text };
  return { queued: true, testID };
};

export const resetPendingE2eAction = () => {
  pendingAction = null;
};
