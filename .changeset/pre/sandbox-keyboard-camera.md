---
"@hot-updater/react-native": patch
---

Sandbox screen fixes. Opening **Enter a channel** or **Enter URL manually** now scrolls the field and its button above the on-screen keyboard, on iOS and Android, also in a window shorter than the form, such as a phone on its side. With camera access off, the iOS QR scanner no longer shows the viewfinder and the aiming hint: it shows one line and an **Open Settings** button, or, when the camera is restricted on the device, only a line saying so. It reads the camera access again when the app comes back to the foreground. A link opened before any bundle runs no longer says it replaces the running bundle. The Geist license reads as paragraphs, without the file's hard line breaks, on both platforms.
