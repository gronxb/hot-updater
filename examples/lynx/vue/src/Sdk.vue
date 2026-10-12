<script setup lang="ts">
import { navigate } from "@hot-updater/lynx-sparkling";
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
  installSdkUpdateWithDetail,
  reloadSdkWithDetail,
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
  <view class="page sdk-page">
    <text class="eyebrow">HOT UPDATER / VUELYNX SDK</text>
    <text :flatten="false" :accessibility-element="true" class="title"
      >Bundle {{ variant }}</text
    >
    <image class="probe" :src="imageUrl" @load="sdkImageLoaded" />
    <text v-if="resources && fontReady" class="font-probe">RELEASE FONT</text>
    <text :flatten="false" :accessibility-element="true" class="description">{{
      status
    }}</text>
    <view
      :flatten="false"
      :accessibility-element="true"
      accessibility-label="Open detail page"
      accessibility-traits="button"
      class="action"
      @tap="openDetail"
    >
      <text :accessibility-element="false" class="action-label"
        >Open detail page</text
      >
    </view>
    <view
      :flatten="false"
      :accessibility-element="true"
      accessibility-label="Verify navigation boundary"
      accessibility-traits="button"
      class="action"
      @tap="verifyNavigationBoundary(setStatus)"
    >
      <text :accessibility-element="false" class="action-label"
        >Verify navigation boundary</text
      >
    </view>
    <view
      :flatten="false"
      :accessibility-element="true"
      accessibility-label="Reload with detail open"
      accessibility-traits="button"
      class="action"
      @tap="reloadSdkWithDetail()"
    >
      <text :accessibility-element="false" class="action-label"
        >Reload with detail open</text
      >
    </view>
    <view
      :flatten="false"
      :accessibility-element="true"
      accessibility-label="Capture runtime events"
      accessibility-traits="button"
      class="action"
      @tap="captureRuntimeEvents(setStatus)"
    >
      <text :accessibility-element="false" class="action-label"
        >Capture runtime events</text
      >
    </view>
    <view
      :flatten="false"
      :accessibility-element="true"
      accessibility-label="Check update"
      accessibility-traits="button"
      class="action"
      @tap="checkSdkUpdate(setStatus, setCanInstall)"
    >
      <text :accessibility-element="false" class="action-label"
        >Check update</text
      >
    </view>
    <view
      v-if="canInstall"
      :flatten="false"
      :accessibility-element="true"
      accessibility-label="Install next launch"
      accessibility-traits="button"
      class="action"
      @tap="installSdkUpdate(setStatus, setCanInstall)"
    >
      <text :accessibility-element="false" class="action-label"
        >Install next launch</text
      >
    </view>
    <view
      v-if="canInstall"
      :flatten="false"
      :accessibility-element="true"
      accessibility-label="Install with detail open"
      accessibility-traits="button"
      class="action"
      @tap="installSdkUpdateWithDetail(setStatus, setCanInstall)"
    >
      <text :accessibility-element="false" class="action-label"
        >Install with detail open</text
      >
    </view>
    <view
      v-if="canInstall"
      :flatten="false"
      :accessibility-element="true"
      accessibility-label="Install and reload"
      accessibility-traits="button"
      class="action"
      @tap="installSdkUpdateAndReload(setStatus, setCanInstall)"
    >
      <text :accessibility-element="false" class="action-label"
        >Install and reload</text
      >
    </view>
  </view>
</template>
