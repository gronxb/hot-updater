#!/bin/zsh
# Regenerates the native artifact fixtures with the toolchains that make real
# apps, so the readers are checked against their output, not against a writer
# of our own: javac and d8 (dex), aapt2 (binary and proto manifests), clang and
# lipo (Mach-O), and plutil (binary plist). Needs an Android SDK with
# build-tools and a platform, a JDK, and Xcode's command line tools.
#
#   zsh packages/protocol/src/nativeArtifact/__fixtures__/generate.sh
set -eu
cd "${0:A:h}"

MIN_BUNDLE_ID=019a2b3c-4d5e-7000-8000-000000000000
OTHER_UUID_V7=019a2b3c-4d5e-7abc-9def-0123456789ab
FINGERPRINT=5de1cdbfefdc1f0b4a1b3c36ed83c246dff317dd540c0393ca76fa758026ec8f

sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
build_tools=$(print -l "$sdk"/build-tools/*(/) | sort -V | tail -1)
android_jar=$(print -l "$sdk"/platforms/android-*/android.jar | sort -V | tail -1)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# dex: the classes the SDK's Gradle tasks generate, plus a substring that is
# no whole literal. other.dex holds another UUIDv7; plain.dex neither.
dex() {
  local name=$1 min_bundle_id=$2 fingerprint=$3
  rm -rf "$tmp/java" "$tmp/classes" "$tmp/dex"
  mkdir -p "$tmp/java/com/hotupdater" "$tmp/classes" "$tmp/dex"
  cat > "$tmp/java/com/hotupdater/Generated.java" <<EOF
package com.hotupdater;

final class Generated {
  static String minBundleId() { return "$min_bundle_id"; }
  static String fingerprint() { return "$fingerprint"; }
  static String label() { return "id=$OTHER_UUID_V7"; }
}
EOF
  javac --release 8 -d "$tmp/classes" "$tmp/java/com/hotupdater/Generated.java"
  "$build_tools/d8" --release --min-api 24 --output "$tmp/dex" \
    "$tmp/classes/com/hotupdater/Generated.class"
  cp "$tmp/dex/classes.dex" "$name"
}
dex classes.dex "$MIN_BUNDLE_ID" "$FINGERPRINT"
dex other.dex "$OTHER_UUID_V7" ""
dex plain.dex "" ""

# Manifests: aapt2 links each into an .apk (binary XML) and with
# --proto-format into the form an .aab's module holds.
mkdir -p "$tmp/res/values"
cat > "$tmp/res/values/strings.xml" <<'EOF'
<resources><string name="channel">beta</string></resources>
EOF
"$build_tools/aapt2" compile --dir "$tmp/res" -o "$tmp/res.zip"
manifest() {
  local name=$1 application=$2
  cat > "$tmp/AndroidManifest.xml" <<EOF
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.app" android:versionCode="42"
    android:versionName="1.4.0">
  <application $application
  </application>
</manifest>
EOF
  "$build_tools/aapt2" link -I "$android_jar" --manifest "$tmp/AndroidManifest.xml" \
    -o "$tmp/binary.apk" "$tmp/res.zip"
  "$build_tools/aapt2" link -I "$android_jar" --manifest "$tmp/AndroidManifest.xml" \
    --proto-format -o "$tmp/proto.apk" "$tmp/res.zip"
  unzip -p "$tmp/binary.apk" AndroidManifest.xml > "$name.axml"
  unzip -p "$tmp/proto.apk" AndroidManifest.xml > "$name.pb"
}
manifest release '>
    <meta-data android:name="com.hotupdater.CHANNEL" android:value="beta"/>
    <meta-data android:name="other" android:value="x"/>'
manifest debuggable 'android:debuggable="true">'
manifest reference '>
    <meta-data android:name="com.hotupdater.CHANNEL" android:value="@string/channel"/>'

# Mach-O: an executable whose __cstring holds the literals, one holding
# another UUIDv7, and a universal binary whose x86_64 slice holds another
# UUIDv7, so arm64's is the one read.
macho() {
  local arch=$1 min_bundle_id=$2 output=$3
  cat > "$tmp/app.c" <<EOF
#include <stdio.h>
const char *min_bundle_id(void) { return "$min_bundle_id"; }
const char *fingerprint(void) { return "$FINGERPRINT"; }
const char *label(void) { return "id=$OTHER_UUID_V7"; }
int main(void) { puts(min_bundle_id()); puts(fingerprint()); puts(label()); return 0; }
EOF
  clang -Os -arch "$arch" -o "$output" "$tmp/app.c"
  strip "$output"
}
macho arm64 "$MIN_BUNDLE_ID" App
macho arm64 "$OTHER_UUID_V7" App-other
macho x86_64 "$OTHER_UUID_V7" "$tmp/App-x86_64"
lipo -create App "$tmp/App-x86_64" -output App-universal

# Info.plist: XML as written, and binary as Xcode packs it.
cat > Info.xml.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>App</string>
  <key>CFBundleIdentifier</key>
  <string>com.example.app</string>
  <key>CFBundleShortVersionString</key>
  <string>1.4.0</string>
  <key>CFBundleVersion</key>
  <string>42</string>
  <key>HOT_UPDATER_CHANNEL</key>
  <string>beta &amp; gamma</string>
  <key>UIRequiredDeviceCapabilities</key>
  <array><string>arm64</string></array>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict>
</plist>
EOF
plutil -convert binary1 -o Info.plist Info.xml.plist
