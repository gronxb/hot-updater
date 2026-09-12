import { createRootRoute, Outlet, useRouter } from "@tanstack/react-router";

import { styles } from "../e2eStack";

function RootLayout() {
  const router = useRouter();
  const path = router.state.location.pathname.replace(/^\//, "");
  const isReady = path === "e2e/ready" || path === "";
  return (
    <scroll-view style={styles.root}>
      <view style={styles.content}>
        {isReady ? null : (
          <view bindtap={() => void router.navigate({ to: "/e2e/ready" })}>
            <text style={styles.back}>Back</text>
          </view>
        )}
        <text style={styles.resultText}>{path || "e2e/ready"}</text>
        <Outlet />
      </view>
    </scroll-view>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
