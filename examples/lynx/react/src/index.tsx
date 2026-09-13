import { root, useEffect, useState } from "@lynx-js/react";

import {
  imageLoaded,
  imageUrl,
  resources,
  startSpike,
  variant,
} from "../../spike/bridge";
import {
  loadDynamicProbe,
  loadExternalBootstrap,
  loadProbeFont,
  probeHttp,
  readNativeModules,
} from "../../spike/native";

import "../../style.css";

declare const __SPIKE_LAZY__: boolean;

function App() {
  const [fontReady, setFontReady] = useState(false);
  const [status, setStatus] = useState(`Bundle ${variant}: initial content`);
  useEffect(() => {
    void startSpike(
      setStatus,
      readNativeModules,
      loadProbeFont,
      () => setFontReady(true),
      __SPIKE_LAZY__
        ? () => import(/* webpackChunkName: "bootstrap" */ "../../spike/lazy")
        : undefined,
      loadExternalBootstrap,
      loadDynamicProbe,
      probeHttp,
    );
  }, []);

  return (
    <view className="page">
      <text className="eyebrow">HOT UPDATER / REACTLYNX G1</text>
      <text className="title">Bundle {variant}</text>
      <image className="probe" src={imageUrl} bindload={imageLoaded} />
      {resources && fontReady ? (
        <text className="font-probe">RELEASE FONT</text>
      ) : null}
      <text className="description">{status}</text>
    </view>
  );
}

root.render(<App />);
