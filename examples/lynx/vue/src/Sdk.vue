<script setup lang="ts">
import { navigate } from "@hot-updater/lynx/navigation";
import { onMounted, ref } from "vue-lynx";

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
  resources,
  sdkImageLoaded,
  startSdk,
  variant,
} from "../../spike/sdk";

import "../../style.css";

const status = ref(`Bundle ${variant}: starting`);
const canInstall = ref(false);
const fontReady = ref(false);
const openDetail = () =>
  navigate(
    {
      path: "detail.lynx.bundle",
      options: { params: { title: "Second Page" } },
    },
    (result) => console.log("HOT_UPDATER_PAGE_OPEN", result),
  );
function setStatus(value: string) {
  status.value = value;
}
function setCanInstall(value: boolean) {
  canInstall.value = value;
}
onMounted(() => {
  void startSdk(
    setStatus,
    () => {
      fontReady.value = true;
    },
    loadProbeFont,
    loadExternalBootstrap,
    loadDynamicProbe,
  );
});
</script>

<template>
  <view class="page">
    <text class="eyebrow">HOT UPDATER / VUELYNX SDK</text>
    <text class="title">Bundle {{ variant }}</text>
    <image class="probe" :src="imageUrl" @load="sdkImageLoaded" />
    <text v-if="resources && fontReady" class="font-probe">RELEASE FONT</text>
    <text class="description">{{ status }}</text>
    <view class="action" @tap="openDetail">
      <text class="action-label">Open detail page</text>
    </view>
    <view class="action" @tap="verifyNavigationBoundary(setStatus)">
      <text class="action-label">Verify navigation boundary</text>
    </view>
    <view class="action" @tap="captureRuntimeEvents(setStatus)">
      <text class="action-label">Capture runtime events</text>
    </view>
    <view class="action" @tap="checkSdkUpdate(setStatus, setCanInstall)">
      <text class="action-label">Check update</text>
    </view>
    <view
      v-if="canInstall"
      class="action"
      @tap="installSdkUpdate(setStatus, setCanInstall)"
    >
      <text class="action-label">Install next launch</text>
    </view>
    <view
      v-if="canInstall"
      class="action"
      @tap="installSdkUpdateAndReload(setStatus, setCanInstall)"
    >
      <text class="action-label">Install and reload</text>
    </view>
  </view>
</template>
