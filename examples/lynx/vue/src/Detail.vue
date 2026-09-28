<script setup lang="ts">
import { close } from "@hot-updater/lynx/navigation";
import { onMounted, ref } from "vue-lynx";

import {
  checkSdkUpdate,
  installSdkUpdateAndReload,
  startDetailSdk,
  variant,
} from "../../spike/sdk";

import "../../style.css";

const status = ref(`Detail bundle ${variant}`);
const canInstall = ref(false);
function setStatus(value: string) {
  status.value = value;
}
function setCanInstall(value: boolean) {
  canInstall.value = value;
}
const closeDetail = () =>
  close(undefined, (result) => console.log("HOT_UPDATER_PAGE_CLOSE", result));
onMounted(() => {
  void startDetailSdk(setStatus);
});
</script>

<template>
  <view class="page">
    <text class="eyebrow">HOT UPDATER / VUELYNX DETAIL</text>
    <text class="title">Detail {{ variant }}</text>
    <text class="description">{{ status }}</text>
    <view class="action" @tap="closeDetail">
      <text class="action-label">Close detail page</text>
    </view>
    <view class="action" @tap="checkSdkUpdate(setStatus, setCanInstall)">
      <text class="action-label">Check update</text>
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
