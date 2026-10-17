import { readE2eRuntimeConfig } from "../e2eRuntimeConfig";
import { hotUpdater } from "./runtime";
import { persistScreenState } from "./screen-state-persistence";

export const runStartupUpdateCheck = async (isActive: () => boolean) => {
  let startupCheckEpoch = "";
  let reloadStarted = false;
  try {
    try {
      startupCheckEpoch = (await readE2eRuntimeConfig()).screenState
        .startupCheckEpoch;
    } catch (error) {
      console.error(error);
    }
    if (!isActive()) return;
    const updateInfo = await hotUpdater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    if (!isActive() || !updateInfo?.shouldForceUpdate) return;
    if (await updateInfo.updateBundle()) {
      // The replacement runtime must complete its own startup check. The old
      // mount must not acknowledge readiness while native reload is starting.
      reloadStarted = true;
      await hotUpdater.reload();
    }
  } catch (error) {
    console.error(error);
  } finally {
    if (isActive() && !reloadStarted && startupCheckEpoch) {
      await persistScreenState({ startupCheckSettledEpoch: startupCheckEpoch });
    }
  }
};
