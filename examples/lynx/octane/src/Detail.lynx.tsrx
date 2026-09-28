/** @jsxImportSource @octanejs/lynx/intrinsics */
import { useEffect, useState } from "octane";
import { close } from "@hot-updater/lynx/navigation";

import { checkSdkUpdate, installSdkUpdateAndReload, startDetailSdk, variant } from "./sdk-shared";

export function Detail() @{
  const [status, setStatus] = useState(`Detail bundle ${variant}`);
  const [canInstall, setCanInstall] = useState(false);
  const closeDetail = () => { close(undefined, (result) => console.log("HOT_UPDATER_PAGE_CLOSE", result)); };
  useEffect(() => {
    void startDetailSdk(setStatus);
  }, []);

  <view class="page">
    <text class="eyebrow">{"HOT UPDATER / OCTANELYNX DETAIL"}</text>
    <text class="title">{"Detail " + variant}</text>
    <text class="description">{status}</text>
    <view class="action" bindtap={closeDetail}>
      <text class="action-label">{"Close detail page"}</text>
    </view>
    <view class="action" bindtap={() => { void checkSdkUpdate(setStatus, setCanInstall); }}>
      <text class="action-label">{"Check update"}</text>
    </view>
    @if (canInstall) {
      <view class="action" bindtap={() => { void installSdkUpdateAndReload(setStatus, setCanInstall); }}>
        <text class="action-label">{"Install and reload"}</text>
      </view>
    }
  </view>
}
