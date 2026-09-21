import { HotUpdater } from "@hot-updater/lynx";
import { close } from "@hot-updater/lynx/navigation";
import { root, useEffect, useState } from "@lynx-js/react";

import "../../style.css";

function Detail() {
  const [status, setStatus] = useState("Loading detail page…");
  useEffect(() => {
    void HotUpdater.notifyAppReady()
      .then(() => setStatus("Detail page ready."))
      .catch((error) => setStatus(`Detail failed: ${String(error)}`));
  }, []);

  return (
    <view className="page">
      <text className="eyebrow">HOT UPDATER / REACTLYNX</text>
      <text className="title">Detail page</text>
      <text className="description">{status}</text>
      <view
        className="action"
        bindtap={() =>
          close(undefined, ({ code }) => {
            if (code !== 1) setStatus("Close failed.");
          })
        }
      >
        <text className="action-label">Close detail page</text>
      </view>
    </view>
  );
}

root.render(<Detail />);
