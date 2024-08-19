import { checkForUpdate } from "./checkForUpdate";
import { init } from "./init";
import { getAppVersion, getBundleVersion, reload } from "./native";
export var HotUpdater = {
    init: init,
    reload: reload,
    checkForUpdate: checkForUpdate,
    getAppVersion: getAppVersion,
    getBundleVersion: getBundleVersion,
};
