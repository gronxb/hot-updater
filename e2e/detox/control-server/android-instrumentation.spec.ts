import { describe, expect, it } from "vitest";

import { hasActiveInstrumentationForPackage } from "./android-instrumentation.ts";

describe("Android instrumentation state", () => {
  it("finds an unfinished instrumentation targeting the app", () => {
    const output = `ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)
  Active instrumentation:
    Instrumentation #0: ActiveInstrumentation{abc com.hotupdaterexample.test/androidx.test.runner.AndroidJUnitRunner 2 procs}
      mFinished=false
      mTargetProcesses=[com.hotupdaterexample]
  OOM levels:`;

    expect(
      hasActiveInstrumentationForPackage(output, "com.hotupdaterexample"),
    ).toBe(true);
  });

  it("ignores an instrumentation targeting another package", () => {
    const output = `  Active instrumentation:
    Instrumentation #0: ActiveInstrumentation{abc example.test/Runner 2 procs}
      mFinished=false
      mTargetProcesses=[com.example.other]
  OOM levels:`;

    expect(
      hasActiveInstrumentationForPackage(output, "com.hotupdaterexample"),
    ).toBe(false);
  });

  it("accepts a replacement app process after instrumentation has cleared", () => {
    const output = `ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)
  All known processes:
    *APP* UID 10235 ProcessRecord{def 16110:com.hotupdaterexample/u0a235}
      mInstr=null
  Active instrumentation:
  OOM levels:`;

    expect(
      hasActiveInstrumentationForPackage(output, "com.hotupdaterexample"),
    ).toBe(false);
  });
});
