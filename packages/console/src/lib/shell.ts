/**
 * `value` as one POSIX shell word: as it is when it holds only characters
 * no shell treats specially, else in single quotes, so a file name or link
 * the Console shows in a command can't run anything when it is pasted.
 */
export const shellQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

/** Opens `link` on an Android emulator; `adb shell` parses it again on the device. */
export const androidOpenLinkCommand = (link: string) =>
  `adb shell am start -a android.intent.action.VIEW -d ${shellQuote(shellQuote(link))}`;

/** Opens `link` on the booted iOS Simulator. */
export const iosOpenLinkCommand = (link: string) =>
  `xcrun simctl openurl booted ${shellQuote(link)}`;
