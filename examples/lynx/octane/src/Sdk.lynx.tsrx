/** @jsxImportSource @octanejs/lynx/intrinsics */
import { useEffect, useState } from "octane";
import { loadDynamicProbe, loadExternalBootstrap, loadProbeFont } from "@hot-updater/lynx-g1-probe";

import { checkSdkUpdate, imageUrl, installSdkUpdate, installSdkUpdateAndReload, resources, sdkImageLoaded, startSdk, variant } from "./sdk-shared";

export function App() @{
  const [status, setStatus] = useState(`Bundle ${variant}: starting`);
  const [canInstall, setCanInstall] = useState(false);
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => { void startSdk(setStatus, () => setFontReady(true), loadProbeFont, loadExternalBootstrap, loadDynamicProbe); }, []);

  <view class="page">
    <text class="eyebrow">{"HOT UPDATER / OCTANELYNX SDK"}</text>
    <text class="title">{"Bundle " + variant}</text>
    <image class="probe" src={imageUrl} bindload={sdkImageLoaded} />
    @if (resources && fontReady) {
      <text class="font-probe">{"RELEASE FONT"}</text>
    }
    <text class="description">{status}</text>
    <view class="action" bindtap={() => { void checkSdkUpdate(setStatus, setCanInstall); }}>
      <text class="action-label">{"Check update"}</text>
    </view>
    @if (canInstall) {
      <view class="action" bindtap={() => { void installSdkUpdate(setStatus, setCanInstall); }}>
        <text class="action-label">{"Install next launch"}</text>
      </view>
      <view class="action" bindtap={() => { void installSdkUpdateAndReload(setStatus, setCanInstall); }}>
        <text class="action-label">{"Install and reload"}</text>
      </view>
    }
  </view>
}
