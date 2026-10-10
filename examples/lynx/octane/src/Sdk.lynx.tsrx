/** @jsxImportSource @octanejs/lynx/intrinsics */
import { useEffect, useState } from "octane";
import { loadDynamicProbe, loadExternalBootstrap, loadProbeFont } from "@hot-updater/lynx-g1-probe";
import { navigate } from "@hot-updater/lynx-sparkling";

import { verifyNavigationBoundary } from "./navigation-boundary";
import { captureRuntimeEvents, checkSdkUpdate, imageUrl, installSdkUpdate, installSdkUpdateAndReload, installSdkUpdateWithDetail, reloadSdkWithDetail, resources, sdkImageLoaded, startSdk, variant } from "./sdk-shared";

export function App() @{
  const [status, setStatus] = useState(`Bundle ${variant}: starting`);
  const [canInstall, setCanInstall] = useState(false);
  const [fontReady, setFontReady] = useState(false);
  const openDetail = () => { navigate({ path: "detail.lynx.bundle", options: { params: { title: "Second Page" } } }, (result) => console.log("HOT_UPDATER_PAGE_OPEN", result)); };
  useEffect(() => { void startSdk(setStatus, () => setFontReady(true), loadProbeFont, loadExternalBootstrap, loadDynamicProbe); }, []);

  <view class="page sdk-page">
    <text class="eyebrow">{"HOT UPDATER / OCTANELYNX SDK"}</text>
    <text flatten={false} accessibility-element={true} class="title">{"Bundle " + variant}</text>
    <image class="probe" src={imageUrl} bindload={sdkImageLoaded} />
    @if (resources && fontReady) {
      <text class="font-probe">{"RELEASE FONT"}</text>
    }
    <text flatten={false} accessibility-element={true} class="description">{status}</text>
    <view flatten={false} accessibility-element={true} accessibility-label="Open detail page" accessibility-traits="button" class="action" bindtap={openDetail}>
      <text accessibility-element={false} class="action-label">{"Open detail page"}</text>
    </view>
    <view flatten={false} accessibility-element={true} accessibility-label="Verify navigation boundary" accessibility-traits="button" class="action" bindtap={() => { void verifyNavigationBoundary(setStatus); }}>
      <text accessibility-element={false} class="action-label">{"Verify navigation boundary"}</text>
    </view>
    <view flatten={false} accessibility-element={true} accessibility-label="Reload with detail open" accessibility-traits="button" class="action" bindtap={() => { void reloadSdkWithDetail(); }}>
      <text accessibility-element={false} class="action-label">{"Reload with detail open"}</text>
    </view>
    <view flatten={false} accessibility-element={true} accessibility-label="Capture runtime events" accessibility-traits="button" class="action" bindtap={() => { void captureRuntimeEvents(setStatus); }}>
      <text accessibility-element={false} class="action-label">{"Capture runtime events"}</text>
    </view>
    <view flatten={false} accessibility-element={true} accessibility-label="Check update" accessibility-traits="button" class="action" bindtap={() => { void checkSdkUpdate(setStatus, setCanInstall); }}>
      <text accessibility-element={false} class="action-label">{"Check update"}</text>
    </view>
    @if (canInstall) {
      <view>
        <view flatten={false} accessibility-element={true} accessibility-label="Install next launch" accessibility-traits="button" class="action" bindtap={() => { void installSdkUpdate(setStatus, setCanInstall); }}>
          <text accessibility-element={false} class="action-label">{"Install next launch"}</text>
        </view>
        <view flatten={false} accessibility-element={true} accessibility-label="Install and reload" accessibility-traits="button" class="action" bindtap={() => { void installSdkUpdateAndReload(setStatus, setCanInstall); }}>
          <text accessibility-element={false} class="action-label">{"Install and reload"}</text>
        </view>
        <view flatten={false} accessibility-element={true} accessibility-label="Install with detail open" accessibility-traits="button" class="action" bindtap={() => { void installSdkUpdateWithDetail(setStatus, setCanInstall); }}>
          <text accessibility-element={false} class="action-label">{"Install with detail open"}</text>
        </view>
      </view>
    }
  </view>
}
