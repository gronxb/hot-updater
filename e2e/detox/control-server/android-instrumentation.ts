export function hasActiveInstrumentationForPackage(
  output: string,
  packageName: string,
) {
  let inActiveInstrumentation = false;
  let inInstrumentation = false;
  let isFinished = true;
  let targetProcesses: string[] = [];

  const matchesPackage = () =>
    inInstrumentation && !isFinished && targetProcesses.includes(packageName);

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!inActiveInstrumentation) {
      if (trimmed === "Active instrumentation:") {
        inActiveInstrumentation = true;
      }
      continue;
    }

    if (trimmed && line.search(/\S/) <= 2) {
      break;
    }

    if (/^Instrumentation #\d+:/.test(trimmed)) {
      if (matchesPackage()) {
        return true;
      }
      inInstrumentation = true;
      isFinished = true;
      targetProcesses = [];
      continue;
    }

    if (!inInstrumentation) {
      continue;
    }

    if (trimmed.startsWith("mFinished=")) {
      isFinished = trimmed === "mFinished=true";
      continue;
    }

    const targetMatch = trimmed.match(/^mTargetProcesses=\[([^\]]*)\]$/);
    if (targetMatch) {
      targetProcesses = targetMatch[1]
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean);
    }
  }

  return matchesPackage();
}
