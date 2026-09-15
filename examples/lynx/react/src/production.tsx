import { navigate } from "@hot-updater/lynx/navigation";
import { root, useEffect, useState } from "@lynx-js/react";

import {
  checkProductionUpdate,
  imageUrl,
  installProductionUpdate,
  productionImageLoaded,
  startProductionSdk,
} from "../../spike/production-sdk";

import "../../style.css";

function App() {
  const [status, setStatus] = useState("Starting…");
  const [canInstall, setCanInstall] = useState(false);
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    void startProductionSdk(setStatus, () => setFontReady(true));
  }, []);

  return (
    <view className="page">
      <text className="eyebrow">HOT UPDATER / REACTLYNX</text>
      <text className="title">Page based updates</text>
      <image
        className="probe"
        src={imageUrl}
        bindload={productionImageLoaded}
      />
      {fontReady ? <text className="font-probe">RELEASE FONT</text> : null}
      <text className="description">{status}</text>
      <view
        className="action"
        bindtap={() =>
          navigate(
            {
              path: "detail.lynx.bundle",
              options: { params: { title: "Second Page" } },
            },
            ({ code }) => {
              if (code !== 1) setStatus("Navigation failed.");
            },
          )
        }
      >
        <text className="action-label">Open detail page</text>
      </view>
      <view
        className="action"
        bindtap={() => void checkProductionUpdate(setStatus, setCanInstall)}
      >
        <text className="action-label">Check update</text>
      </view>
      {canInstall ? (
        <>
          <view
            className="action"
            bindtap={() =>
              void installProductionUpdate(setStatus, setCanInstall, false)
            }
          >
            <text className="action-label">Install next launch</text>
          </view>
          <view
            className="action"
            bindtap={() =>
              void installProductionUpdate(setStatus, setCanInstall, true)
            }
          >
            <text className="action-label">Install and reload</text>
          </view>
        </>
      ) : null}
    </view>
  );
}

root.render(<App />);
