import { HotUpdater } from "@hot-updater/lynx";
import { close } from "@hot-updater/lynx/navigation";
import { root, useEffect, useState } from "@lynx-js/react";

import { variant } from "../../spike/bridge";

import "../../style.css";

declare const __SPIKE_BEHAVIOR__: string;

function Detail() {
  const [status, setStatus] = useState(`Detail bundle ${variant}`);
  useEffect(() => {
    if (["unconfirmed", "detail-unconfirmed"].includes(__SPIKE_BEHAVIOR__)) {
      setStatus(`Detail bundle ${variant}: readiness deliberately withheld`);
      console.log("HOT_UPDATER_DETAIL_UNCONFIRMED", variant);
      return;
    }
    void HotUpdater.notifyAppReady()
      .then((receipt) => {
        setStatus(`Detail bundle ${variant} ready`);
        console.log("HOT_UPDATER_DETAIL_READY", JSON.stringify(receipt));
      })
      .catch((error) => setStatus(`Detail failed: ${String(error)}`));
  }, []);

  return (
    <view className="page">
      <text className="eyebrow">HOT UPDATER / REACTLYNX DETAIL</text>
      <text className="title">Detail {variant}</text>
      <text className="description">{status}</text>
      <view
        className="action"
        bindtap={() =>
          close(undefined, (result) =>
            console.log("HOT_UPDATER_PAGE_CLOSE", result),
          )
        }
      >
        <text className="action-label">Close detail page</text>
      </view>
    </view>
  );
}

root.render(<Detail />);
