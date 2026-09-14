/** @jsxImportSource @octanejs/lynx/intrinsics */
import { useEffect, useState } from "octane";
import { HotUpdater } from "@hot-updater/lynx";
import { close } from "@hot-updater/lynx/navigation";

import { variant } from "./bridge";

declare const __SPIKE_BEHAVIOR__: string;

export function Detail() @{
  const [status, setStatus] = useState(`Detail bundle ${variant}`);
  const closeDetail = () => { close(undefined, (result) => console.log("HOT_UPDATER_PAGE_CLOSE", result)); };
  useEffect(() => {
    if (["unconfirmed", "detail-unconfirmed"].includes(__SPIKE_BEHAVIOR__)) {
      setStatus(`Detail bundle ${variant}: readiness deliberately withheld`);
      console.log("HOT_UPDATER_DETAIL_UNCONFIRMED", variant);
      return;
    }
    void HotUpdater.notifyAppReady().then((receipt) => {
    setStatus(`Detail bundle ${variant} ready`);
    console.log("HOT_UPDATER_DETAIL_READY", JSON.stringify(receipt));
  }).catch((error) => setStatus(`Detail failed: ${String(error)}`));
  }, []);

  <view class="page">
    <text class="eyebrow">{"HOT UPDATER / OCTANELYNX DETAIL"}</text>
    <text class="title">{"Detail " + variant}</text>
    <text class="description">{status}</text>
    <view class="action" bindtap={closeDetail}>
      <text class="action-label">{"Close detail page"}</text>
    </view>
  </view>
}
