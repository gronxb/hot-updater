import { root, useEffect, useState } from "@lynx-js/react";

import {
  loadDynamicProbe,
  loadExternalBootstrap,
  loadProbeFont,
} from "../../spike/native";
import {
  checkSdkUpdate,
  imageUrl,
  installSdkUpdate,
  resources,
  sdkImageLoaded,
  startSdk,
  variant,
} from "../../spike/sdk";

import "../../style.css";

function App() {
  const [status, setStatus] = useState(`Bundle ${variant}: starting`);
  const [canInstall, setCanInstall] = useState(false);
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    void startSdk(
      setStatus,
      () => setFontReady(true),
      loadProbeFont,
      loadExternalBootstrap,
      loadDynamicProbe,
    );
  }, []);

  return (
    <view className="page">
      <text className="eyebrow">HOT UPDATER / REACTLYNX SDK</text>
      <text className="title">Bundle {variant}</text>
      <image className="probe" src={imageUrl} bindload={sdkImageLoaded} />
      {resources && fontReady ? (
        <text className="font-probe">RELEASE FONT</text>
      ) : null}
      <text className="description">{status}</text>
      <view
        className="action"
        bindtap={() => void checkSdkUpdate(setStatus, setCanInstall)}
      >
        <text className="action-label">Check update</text>
      </view>
      {canInstall ? (
        <view
          className="action"
          bindtap={() => void installSdkUpdate(setStatus, setCanInstall)}
        >
          <text className="action-label">Install next launch</text>
        </view>
      ) : null}
    </view>
  );
}

root.render(<App />);
