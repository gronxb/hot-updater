// A dev session's view of main's HotUpdaterImpl, for what reaches it from the
// bridge and the host: the bundle, and everything that would read or write the
// normal selection's state. The deepest selector, since reload() calls it
// directly (HotUpdater.mm), so the session holds across an in-place reload.
// Swift calling the same methods within the SDK and the sandbox's own view keep
// the real implementation.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>

typedef void (^HUResolve)(id _Nullable);

// What this file calls in the sandbox's Swift. Declared here, since the generated
// Swift header imports React, whose C++ headers a plain Objective-C file can't read
// when React Native is a prebuilt framework.
@interface HotUpdaterSandboxDevState : NSObject
+ (nullable NSURL *)bundleURLForImpl:(id)impl;
+ (nullable NSString *)storageItem:(NSString *)key;
+ (void)setStorageItem:(NSString *)key value:(nullable NSString *)value;
+ (void)overrideInstalled;
@end

static NSString *const kDevChannel = @"hot-updater-sandbox-dev-server";

static NSDictionary *EmptyState(void) {
  return @{
    @"activeSelection" : NSNull.null,
    @"stableSelection" : NSNull.null,
    @"verificationPending" : @NO,
    @"highestSeenCatalogs" : @{},
  };
}

static BOOL IsDev(id impl) {
  return [HotUpdaterSandboxDevState bundleURLForImpl:impl] != nil;
}

/// Each original, with the selector it answers. Filled before any is replaced, so
/// nothing is replaced unless all exist.
static id (*gBundleURL)(id, SEL, id);
static id (*gChannel)(id, SEL);
static id (*gActiveState)(id, SEL);
static id (*gBundleId)(id, SEL);
static id (*gBaseURL)(id, SEL);
static id (*gManifest)(id, SEL);
static id (*gNotifyAppReady)(id, SEL);
static id (*gCrashHistory)(id, SEL);
static BOOL (*gClearCrashHistory)(id, SEL);
static BOOL (*gAcceptCatalog)(id, SEL, id);
static BOOL (*gSelectionCurrent)(id, SEL, id);
static void (*gCommit)(id, SEL, id, id, id);
static void (*gUpdate)(id, SEL, id, id, id);
static void (*gInstall)(id, SEL, id, id, id);
static id (*gGetItem)(id, SEL, id);
static void (*gSetItem)(id, SEL, id, id);
static void (*gReset)(id, SEL, id, id, id);
static void (*gResetIf)(id, SEL, id, id, id, id);
static id (*gTakeEvents)(id, SEL, id);

@interface HotUpdaterSandboxDevOverride : NSObject
@end

@implementation HotUpdaterSandboxDevOverride

+ (void)load {
  Class impl = objc_getClass("_TtC10HotUpdater14HotUpdaterImpl");
  Class bridge = objc_getClass("HotUpdaterNativeUpdateBridge");
  Class bridgeMeta = bridge ? object_getClass(bridge) : Nil;
  SEL selectors[] = {
      @selector(bundleURLWithBundle:), @selector(getChannel), @selector(getActiveUpdateState), @selector(getBundleId),
      @selector(getBaseURL), @selector(getManifest), @selector(notifyAppReady), @selector(getCrashHistory),
      @selector(clearCrashHistory), @selector(acceptReleaseCatalog:), @selector(isReleaseSelectionCurrent:),
      @selector(commitReleaseSelection:resolver:rejecter:), @selector(updateBundle:resolver:rejecter:),
      @selector(installArtifact:resolver:rejecter:), @selector(getStorageItem:), @selector(setStorageItem:value:),
  };
  SEL bridgeSelectors[] = {
      @selector(resetChannelWithImpl:resolver:rejecter:),
      @selector(resetChannelIfSelectionCurrentWithImpl:params:resolver:rejecter:),
      @selector(takeEventsWithImpl:),
  };
  BOOL complete = impl != Nil && bridgeMeta != Nil;
  for (size_t i = 0; complete && i < sizeof(selectors) / sizeof(SEL); i++) {
    complete = class_getInstanceMethod(impl, selectors[i]) != NULL;
    if (!complete) NSLog(@"[HotUpdaterSandbox] no %@ to override", NSStringFromSelector(selectors[i]));
  }
  for (size_t i = 0; complete && i < sizeof(bridgeSelectors) / sizeof(SEL); i++) {
    complete = class_getInstanceMethod(bridgeMeta, bridgeSelectors[i]) != NULL;
    if (!complete) NSLog(@"[HotUpdaterSandbox] no %@ to override", NSStringFromSelector(bridgeSelectors[i]));
  }
  if (!complete) return;

#define HU_SWAP(cls, name, selector, block)                                     \
  {                                                                             \
    Method method = class_getInstanceMethod(cls, selector);                     \
    g##name = (void *)method_getImplementation(method);                         \
    method_setImplementation(method, imp_implementationWithBlock(block));       \
  }

  HU_SWAP(impl, BundleURL, @selector(bundleURLWithBundle:), ^id(id me, id bundle) {
    return [HotUpdaterSandboxDevState bundleURLForImpl:me] ?: gBundleURL(me, @selector(bundleURLWithBundle:), bundle);
  });
  HU_SWAP(impl, Channel, @selector(getChannel), ^id(id me) {
    return IsDev(me) ? kDevChannel : gChannel(me, @selector(getChannel));
  });
  HU_SWAP(impl, ActiveState, @selector(getActiveUpdateState), ^id(id me) {
    return IsDev(me) ? EmptyState() : gActiveState(me, @selector(getActiveUpdateState));
  });
  HU_SWAP(impl, BundleId, @selector(getBundleId), ^id(id me) {
    return IsDev(me) ? nil : gBundleId(me, @selector(getBundleId));
  });
  HU_SWAP(impl, BaseURL, @selector(getBaseURL), ^id(id me) {
    return IsDev(me) ? nil : gBaseURL(me, @selector(getBaseURL));
  });
  HU_SWAP(impl, Manifest, @selector(getManifest), ^id(id me) {
    return IsDev(me) ? @{} : gManifest(me, @selector(getManifest));
  });
  // The last normal launch's report stays for the normal launch it describes.
  HU_SWAP(impl, NotifyAppReady, @selector(notifyAppReady), ^id(id me) {
    return IsDev(me) ? @{@"status" : @"UNCHANGED"} : gNotifyAppReady(me, @selector(notifyAppReady));
  });
  HU_SWAP(impl, CrashHistory, @selector(getCrashHistory), ^id(id me) {
    return IsDev(me) ? @[] : gCrashHistory(me, @selector(getCrashHistory));
  });
  HU_SWAP(impl, ClearCrashHistory, @selector(clearCrashHistory), ^BOOL(id me) {
    return IsDev(me) ? YES : gClearCrashHistory(me, @selector(clearCrashHistory));
  });
  HU_SWAP(impl, AcceptCatalog, @selector(acceptReleaseCatalog:), ^BOOL(id me, id params) {
    return IsDev(me) ? YES : gAcceptCatalog(me, @selector(acceptReleaseCatalog:), params);
  });
  HU_SWAP(impl, SelectionCurrent, @selector(isReleaseSelectionCurrent:), ^BOOL(id me, id params) {
    return IsDev(me) ? YES : gSelectionCurrent(me, @selector(isReleaseSelectionCurrent:), params);
  });
  HU_SWAP(impl, Commit, @selector(commitReleaseSelection:resolver:rejecter:), ^(id me, id params, HUResolve resolve, id reject) {
    if (IsDev(me)) {
      resolve(@YES);
    } else {
      gCommit(me, @selector(commitReleaseSelection:resolver:rejecter:), params, resolve, reject);
    }
  });
  HU_SWAP(impl, Update, @selector(updateBundle:resolver:rejecter:), ^(id me, id params, HUResolve resolve, id reject) {
    if (IsDev(me)) {
      resolve(@{});
    } else {
      gUpdate(me, @selector(updateBundle:resolver:rejecter:), params, resolve, reject);
    }
  });
  HU_SWAP(impl, Install, @selector(installArtifact:resolver:rejecter:), ^(id me, id params, HUResolve resolve, id reject) {
    if (IsDev(me)) {
      resolve(@{});
    } else {
      gInstall(me, @selector(installArtifact:resolver:rejecter:), params, resolve, reject);
    }
  });
  // A session's plugin values and server config stay out of the app's own.
  HU_SWAP(impl, GetItem, @selector(getStorageItem:), ^id(id me, id key) {
    return IsDev(me) ? [HotUpdaterSandboxDevState storageItem:key] : gGetItem(me, @selector(getStorageItem:), key);
  });
  HU_SWAP(impl, SetItem, @selector(setStorageItem:value:), ^(id me, id key, id value) {
    if (IsDev(me)) {
      [HotUpdaterSandboxDevState setStorageItem:key value:value];
    } else {
      gSetItem(me, @selector(setStorageItem:value:), key, value);
    }
  });
  HU_SWAP(bridgeMeta, Reset, @selector(resetChannelWithImpl:resolver:rejecter:), ^(id me, id target, HUResolve resolve, id reject) {
    if (IsDev(target)) {
      resolve(@YES);
    } else {
      gReset(me, @selector(resetChannelWithImpl:resolver:rejecter:), target, resolve, reject);
    }
  });
  HU_SWAP(bridgeMeta, ResetIf, @selector(resetChannelIfSelectionCurrentWithImpl:params:resolver:rejecter:), ^(id me, id target, id params, HUResolve resolve, id reject) {
    if (IsDev(target)) {
      resolve(@YES);
    } else {
      gResetIf(me, @selector(resetChannelIfSelectionCurrentWithImpl:params:resolver:rejecter:), target, params, resolve, reject);
    }
  });
  HU_SWAP(bridgeMeta, TakeEvents, @selector(takeEventsWithImpl:), ^id(id me, id target) {
    return IsDev(target) ? nil : gTakeEvents(me, @selector(takeEventsWithImpl:), target);
  });
  [HotUpdaterSandboxDevState overrideInstalled];
}

@end
