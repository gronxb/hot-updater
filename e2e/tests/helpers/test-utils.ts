import { by, device, element, expect, waitFor } from "detox";

/**
 * Waits for the app to be ready after launch
 */
export async function waitForAppReady(_timeout = 10000) {
  await device.launchApp({ newInstance: true });
  // Add a small delay to ensure the app has fully initialized
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

/**
 * Reloads the React Native app (similar to pressing R+R in development)
 */
export async function reloadApp() {
  await device.reloadReactNative();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

/**
 * Terminates the app
 */
export async function terminateApp() {
  await device.terminateApp();
}

/**
 * Waits for an element to be visible with a custom timeout
 */
export async function waitForElement(
  matcher: Detox.NativeElement,
  timeout = 10000,
) {
  await waitFor(matcher).toBeVisible().withTimeout(timeout);
}

/**
 * Waits for an element to disappear
 */
export async function waitForElementToDisappear(
  matcher: Detox.NativeElement,
  timeout = 10000,
) {
  await waitFor(matcher).not.toBeVisible().withTimeout(timeout);
}

/**
 * Taps an element and waits for it to be tapped
 */
export async function tapElement(matcher: Detox.NativeElement) {
  await matcher.tap();
  // Small delay after tap
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/**
 * Types text into an element
 */
export async function typeText(matcher: Detox.NativeElement, text: string) {
  await matcher.typeText(text);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/**
 * Scrolls to an element and taps it
 */
export async function scrollToAndTap(
  scrollViewMatcher: Detox.NativeElement,
  elementMatcher: Detox.NativeElement,
  direction: "up" | "down" = "down",
) {
  await waitFor(elementMatcher)
    .toBeVisible()
    .whileElement(by.id(scrollViewMatcher.toString()))
    .scroll(100, direction);

  await tapElement(elementMatcher);
}

/**
 * Takes a screenshot with a given name
 */
export async function takeScreenshot(name: string) {
  await device.takeScreenshot(name);
}

/**
 * Checks if the app is running in debug mode
 */
export function isDebugMode(): boolean {
  return process.env.NODE_ENV === "development";
}

/**
 * Gets the platform (ios or android)
 */
export function getPlatform(): "ios" | "android" {
  return device.getPlatform() as "ios" | "android";
}

/**
 * Conditional test execution based on platform
 */
export function describeIOS(name: string, fn: () => void) {
  if (getPlatform() === "ios") {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

export function describeAndroid(name: string, fn: () => void) {
  if (getPlatform() === "android") {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

/**
 * Wait for a specific time
 */
export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clear app data and restart
 */
export async function clearAppDataAndRestart() {
  await device.terminateApp();
  await device.launchApp({ newInstance: true, delete: true });
  await sleep(2000);
}

/**
 * Sends the app to background and brings it back
 */
export async function sendToBackgroundAndResume(duration = 2000) {
  await device.sendToHome();
  await sleep(duration);
  await device.launchApp({ newInstance: false });
  await sleep(1000);
}

export { element, by, device, waitFor };

export const detoxExpect = expect;
