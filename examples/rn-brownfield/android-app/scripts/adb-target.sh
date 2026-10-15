#!/bin/sh
# Prints the serial adb should talk to: ANDROID_SERIAL when set, otherwise the
# first attached emulator, otherwise the first attached device. Gradle's
# installRelease installs on every device, but adb shell needs exactly one.
if [ -n "$ANDROID_SERIAL" ]; then
  echo "$ANDROID_SERIAL"
  exit 0
fi
adb devices | awk 'NR > 1 && $2 == "device" { if ($1 ~ /^emulator-/) { print $1; found = 1; exit } if (!first) first = $1 } END { if (!found && first) print first }'
