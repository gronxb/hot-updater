import { describe, expect, it } from "vitest";

import { parseAndroidProcessState } from "./android-process-state.ts";

// Lines of `dumpsys activity processes <package>` on an Android 15 emulator.
const FROZEN = `  *APP* UID 10207 ProcessRecord{c0ffee 3400:com.hotupdaterexample/u0a207}
    oom adj: max=1001 curRaw=900 setRaw=900 cur=900 set=900
    curProcState=19 mRepProcState=19 setProcState=19 lastStateTime=-12s3ms
    hasPendingCompaction=false    isFreezeExempt=false isPendingFreeze=false isFrozen=true
`;

describe("parseAndroidProcessState", () => {
  it("reads a cached process the freezer froze", () => {
    expect(parseAndroidProcessState(FROZEN)).toEqual({
      frozen: true,
      oomAdj: 900,
      pendingFreeze: false,
    });
  });

  it("reads a process a running job keeps out of the cache", () => {
    expect(
      parseAndroidProcessState(
        FROZEN.replace(/900/g, "500").replace(
          "isFrozen=true",
          "isFrozen=false",
        ),
      ),
    ).toEqual({ frozen: false, oomAdj: 500, pendingFreeze: false });
  });

  it("reports nothing for a process that is not running", () => {
    expect(parseAndroidProcessState("")).toEqual({
      frozen: null,
      oomAdj: null,
      pendingFreeze: null,
    });
  });
});
