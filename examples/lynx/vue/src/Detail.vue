<script setup lang="ts">
import { HotUpdater } from "@hot-updater/lynx";
import { close } from "@hot-updater/lynx/navigation";
import { onMounted, ref } from "vue-lynx";

import { variant } from "../../spike/bridge";

import "../../style.css";

declare const __SPIKE_BEHAVIOR__: string;

const status = ref(`Detail bundle ${variant}`);
const closeDetail = () =>
  close(undefined, (result) => console.log("HOT_UPDATER_PAGE_CLOSE", result));
onMounted(() => {
  if (["unconfirmed", "detail-unconfirmed"].includes(__SPIKE_BEHAVIOR__)) {
    status.value = `Detail bundle ${variant}: readiness deliberately withheld`;
    console.log("HOT_UPDATER_DETAIL_UNCONFIRMED", variant);
    return;
  }
  void HotUpdater.notifyAppReady()
    .then((receipt) => {
      status.value = `Detail bundle ${variant} ready`;
      console.log("HOT_UPDATER_DETAIL_READY", JSON.stringify(receipt));
    })
    .catch((error) => {
      status.value = `Detail failed: ${String(error)}`;
    });
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
  </view>
</template>
