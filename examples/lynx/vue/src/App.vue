<script setup lang="ts">
import { onMounted, ref } from "vue-lynx";

import {
  imageLoaded,
  imageUrl,
  resources,
  startSpike,
  variant,
} from "../../spike/bridge";
import {
  loadDynamicProbe,
  loadExternalBootstrap,
  loadProbeFont,
  probeHttp,
  readNativeModules,
} from "../../spike/native";

import "../../style.css";

declare const __SPIKE_LAZY__: boolean;

const status = ref(`Bundle ${variant}: initial content`);
const fontReady = ref(false);
onMounted(() => {
  void startSpike(
    (message) => {
      status.value = message;
    },
    readNativeModules,
    loadProbeFont,
    () => {
      fontReady.value = true;
    },
    __SPIKE_LAZY__
      ? () => import(/* webpackChunkName: "bootstrap" */ "../../spike/lazy")
      : undefined,
    loadExternalBootstrap,
    loadDynamicProbe,
    probeHttp,
  );
});
</script>

<template>
  <view class="page">
    <text class="eyebrow">HOT UPDATER / VUELYNX G1</text>
    <text class="title">Bundle {{ variant }}</text>
    <image class="probe" :src="imageUrl" @load="imageLoaded" />
    <text v-if="resources && fontReady" class="font-probe">RELEASE FONT</text>
    <text class="description">{{ status }}</text>
  </view>
</template>
