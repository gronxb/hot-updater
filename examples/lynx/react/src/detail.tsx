import { close } from "@hot-updater/lynx/navigation";
import { root, useEffect, useState } from "@lynx-js/react";

import {
  checkSdkUpdate,
  installSdkUpdateAndReload,
  startDetailSdk,
  variant,
} from "../../spike/sdk";

import "../../style.css";

function Detail() {
  const [status, setStatus] = useState(`Detail bundle ${variant}`);
  const [canInstall, setCanInstall] = useState(false);
  useEffect(() => {
    void startDetailSdk(setStatus);
  }, []);

  return (
    <view className="page">
      <text className="eyebrow">HOT UPDATER / REACTLYNX DETAIL</text>
      <text className="title">Detail {variant}</text>
      <text className="description">{status}</text>
      <view
        className="action"
        bindtap={() =>
          close({ animated: false }, (result) =>
            console.log("HOT_UPDATER_PAGE_CLOSE", result),
          )
        }
      >
        <text className="action-label">Close detail page</text>
      </view>
      <view
        className="action"
        bindtap={() => void checkSdkUpdate(setStatus, setCanInstall)}
      >
        <text className="action-label">Check update</text>
      </view>
      {canInstall ? (
        <view
          className="action"
          bindtap={() =>
            void installSdkUpdateAndReload(setStatus, setCanInstall)
          }
        >
          <text className="action-label">Install and reload</text>
        </view>
      ) : null}
    </view>
  );
}

root.render(<Detail />);
