import { navigate } from "@hot-updater/lynx-sparkling";
import { root, useEffect, useState } from "@lynx-js/react";

import {
  loadDynamicProbe,
  loadExternalBootstrap,
  loadProbeFont,
} from "../../spike/native";
import { verifyNavigationBoundary } from "../../spike/navigation-boundary";
import {
  captureRuntimeEvents,
  checkSdkUpdate,
  imageUrl,
  installSdkUpdate,
  installSdkUpdateAndReload,
  installSdkUpdateWithDetail,
  reloadSdkWithDetail,
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
    <view className="page sdk-page">
      <text className="eyebrow">HOT UPDATER / REACTLYNX SDK</text>
      <text flatten={false} accessibility-element={true} className="title">
        Bundle {variant}
      </text>
      <image className="probe" src={imageUrl} bindload={sdkImageLoaded} />
      {resources && fontReady ? (
        <text className="font-probe">RELEASE FONT</text>
      ) : null}
      <text
        flatten={false}
        accessibility-element={true}
        className="description"
      >
        {status}
      </text>
      <view
        flatten={false}
        accessibility-element={true}
        accessibility-label="Open detail page"
        accessibility-traits="button"
        className="action"
        bindtap={() =>
          navigate(
            {
              path: "detail.lynx.bundle",
              options: { params: { title: "Second Page" } },
            },
            (result) => console.log("HOT_UPDATER_PAGE_OPEN", result),
          )
        }
      >
        <text accessibility-element={false} className="action-label">
          Open detail page
        </text>
      </view>
      <view
        flatten={false}
        accessibility-element={true}
        accessibility-label="Reload with detail open"
        accessibility-traits="button"
        className="action"
        bindtap={() => void reloadSdkWithDetail()}
      >
        <text accessibility-element={false} className="action-label">
          Reload with detail open
        </text>
      </view>
      <view
        flatten={false}
        accessibility-element={true}
        accessibility-label="Verify navigation boundary"
        accessibility-traits="button"
        className="action"
        bindtap={() => void verifyNavigationBoundary(setStatus)}
      >
        <text accessibility-element={false} className="action-label">
          Verify navigation boundary
        </text>
      </view>
      <view
        flatten={false}
        accessibility-element={true}
        accessibility-label="Capture runtime events"
        accessibility-traits="button"
        className="action"
        bindtap={() => void captureRuntimeEvents(setStatus)}
      >
        <text accessibility-element={false} className="action-label">
          Capture runtime events
        </text>
      </view>
      <view
        flatten={false}
        accessibility-element={true}
        accessibility-label="Check update"
        accessibility-traits="button"
        className="action"
        bindtap={() => void checkSdkUpdate(setStatus, setCanInstall)}
      >
        <text accessibility-element={false} className="action-label">
          Check update
        </text>
      </view>
      {canInstall ? (
        <>
          <view
            flatten={false}
            accessibility-element={true}
            accessibility-label="Install next launch"
            accessibility-traits="button"
            className="action"
            bindtap={() => void installSdkUpdate(setStatus, setCanInstall)}
          >
            <text accessibility-element={false} className="action-label">
              Install next launch
            </text>
          </view>
          <view
            flatten={false}
            accessibility-element={true}
            accessibility-label="Install with detail open"
            accessibility-traits="button"
            className="action"
            bindtap={() =>
              void installSdkUpdateWithDetail(setStatus, setCanInstall)
            }
          >
            <text accessibility-element={false} className="action-label">
              Install with detail open
            </text>
          </view>
          <view
            flatten={false}
            accessibility-element={true}
            accessibility-label="Install and reload"
            accessibility-traits="button"
            className="action"
            bindtap={() =>
              void installSdkUpdateAndReload(setStatus, setCanInstall)
            }
          >
            <text accessibility-element={false} className="action-label">
              Install and reload
            </text>
          </view>
        </>
      ) : null}
    </view>
  );
}

root.render(<App />);
