<script setup lang="ts">
import { onMounted, ref } from "vue-lynx";

import {
  loadDynamicProbe,
  loadExternalBootstrap,
  loadProbeFont,
} from "../../spike/native";
import {
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
