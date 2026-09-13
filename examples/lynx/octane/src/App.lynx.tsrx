/** @jsxImportSource @octanejs/lynx/intrinsics */
import { useEffect, useState } from "octane";
import { loadDynamicProbe, loadExternalBootstrap, loadProbeFont, probeHttp, readNativeModules } from "@hot-updater/lynx-g1-probe";

import { imageLoaded, imageUrl, resources, startSpike, variant } from "./bridge";

declare const __SPIKE_LAZY__: boolean;

export function App() @{
  const [fontReady, setFontReady] = useState(false);
  const [status, setStatus] = useState(`Bundle ${variant}: initial content`);
  useEffect(() => { void startSpike(setStatus, readNativeModules, loadProbeFont, () => setFontReady(true),
    __SPIKE_LAZY__ ? () => import(/* webpackChunkName: "bootstrap" */ "./lazy") : undefined, loadExternalBootstrap, loadDynamicProbe, probeHttp); }, []);

  <view class="page">
    <text class="eyebrow">{"HOT UPDATER / OCTANELYNX G1"}</text>
    <text class="title">{"Bundle " + variant}</text>
    <image class="probe" src={imageUrl} bindload={imageLoaded} />
    @if (resources && fontReady) {
      <text class="font-probe">{"RELEASE FONT"}</text>
    }
    <text class="description">{status}</text>
  </view>
}
