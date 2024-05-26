# hot-updater (WIP)
React Native OTA solution for internal infrastructure

## Usage
* as-is
```objective-c
// filename: ios/MyApp/AppDelegate.mm
// ...
#import <HotUpdater/HotUpdater.h>

// ...

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
    #if DEBUG
      return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
    #else
      return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
    #endif
}

// ...
```

* to-be
```objective-c
// filename: ios/MyApp/AppDelegate.mm
// ...

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
    return [HotUpdater bundleURL];
}

// ...
```

## Android Debug
```sh
> adb logcat -s HotUpdater
```