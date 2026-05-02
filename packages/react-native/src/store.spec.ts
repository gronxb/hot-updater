import { beforeEach, describe, expect, it, vi } from "vitest";

const addListenerMock = vi.hoisted(() => vi.fn());

vi.mock("./native", () => ({
  addListener: addListenerMock,
}));

const importStore = async () => {
  const { hotUpdaterStore } = await import("./store");
  return hotUpdaterStore;
};

describe("hotUpdaterStore", () => {
  beforeEach(() => {
    vi.resetModules();
    addListenerMock.mockReset();
  });

  it("does not notify subscribers when state values are unchanged", async () => {
    const store = await importStore();
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);

    store.setState({});
    store.setState({ progress: 0 });
    store.setState({ isUpdateDownloaded: false });

    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("notifies subscribers only when progress events change the snapshot", async () => {
    const store = await importStore();
    const listener = vi.fn();
    const progressListener = addListenerMock.mock.calls[0][1] as (state: {
      progress: number;
    }) => void;

    const unsubscribe = store.subscribe(listener);

    progressListener({ progress: 0.5 });
    progressListener({ progress: 0.5 });
    progressListener({ progress: 1 });
    store.setState({ isUpdateDownloaded: true });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({
      isUpdateDownloaded: true,
      progress: 1,
    });

    unsubscribe();
  });
});
