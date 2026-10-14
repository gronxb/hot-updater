#import "HotUpdater.h"
#import <React/RCTExceptionsManager.h>
#import <React/RCTInitializing.h>
#import <React/RCTReloadCommand.h>
#import <React/RCTLog.h>

#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <unistd.h>

#if defined(SWIFT_PACKAGE)
// Swift Package Manager: the Swift classes, through the protocols they conform
// to (see HotUpdaterInterface.h).
#import "HotUpdaterInterface.h"
typedef NSObject<HotUpdaterImplInterface> HotUpdaterImpl;
typedef NSObject<HotUpdaterConfigInterface> HotUpdaterConfig;
#else
#if __has_include("HotUpdater/HotUpdater-Swift.h")
#import "HotUpdater/HotUpdater-Swift.h"
#else
#import "HotUpdater-Swift.h"
#endif

static HotUpdaterImpl *HotUpdaterMakeImpl(void)
{
  return [[HotUpdaterImpl alloc] init];
}

static NSString *HotUpdaterAppVersion(void)
{
  return [HotUpdaterImpl appVersion];
}

static HotUpdaterConfig *HotUpdaterSharedConfig(void)
{
  return [HotUpdaterConfig shared];
}
#endif

@interface HotUpdater (InternalSharedImpl)
+ (HotUpdaterImpl *)sharedImpl;
@end

extern "C" NSString *HotUpdaterBuildMinBundleId(void);

namespace {
constexpr size_t kHotUpdaterMaxBundleIdLength = 128;
const int kHotUpdaterSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP};

char gHotUpdaterCrashMarkerPath[PATH_MAX] = {0};
char gHotUpdaterBundleId[kHotUpdaterMaxBundleIdLength] = {0};
volatile sig_atomic_t gHotUpdaterShouldRollback = 0;
struct sigaction gHotUpdaterPreviousActions[NSIG];
__weak RCTBridge *gHotUpdaterBridge = nil;

void HotUpdaterTriggerReloadCommand(RCTBridge *bridge, NSString *reason)
{
#ifdef RCT_NEW_ARCH_ENABLED
  RCTTriggerReloadCommandListeners(reason);
#else
  // RCTBridge starts the next old-architecture bridge before its asynchronous
  // module invalidation finishes. Wait for this exact child bridge first.
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!bridge || !bridge.valid) {
      RCTTriggerReloadCommandListeners(reason);
      return;
    }

    __block id observer = nil;
    observer = [[NSNotificationCenter defaultCenter]
        addObserverForName:RCTBridgeDidInvalidateModulesNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
                  RCTBridge *invalidatedBridge = notification.userInfo[@"bridge"];
                  if (notification.object != bridge && invalidatedBridge != bridge) {
                    return;
                  }
                  [[NSNotificationCenter defaultCenter] removeObserver:observer];
                  observer = nil;
                  RCTTriggerReloadCommandListeners(reason);
                }];

    [bridge invalidate];
  });
#endif
}

size_t HotUpdaterSafeStringLength(const char *value, size_t maxLength)
{
  size_t length = 0;
  while (length < maxLength && value[length] != '\0') {
    ++length;
  }
  return length;
}

void HotUpdaterSafeCopy(char *destination, size_t destinationSize, const char *source)
{
  if (destinationSize == 0) {
    return;
  }

  size_t index = 0;
  while (index + 1 < destinationSize && source[index] != '\0') {
    destination[index] = source[index];
    ++index;
  }
  destination[index] = '\0';
}

void HotUpdaterWriteCrashMarker()
{
  if (gHotUpdaterCrashMarkerPath[0] == '\0') {
    return;
  }

  int fd = open(gHotUpdaterCrashMarkerPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    return;
  }

  constexpr char prefix[] = "{\"bundleId\":\"";
  constexpr char middle[] = "\",\"shouldRollback\":";
  constexpr char trueLiteral[] = "true";
  constexpr char falseLiteral[] = "false";
  constexpr char suffix[] = "}\n";

  write(fd, prefix, sizeof(prefix) - 1);
  if (gHotUpdaterBundleId[0] != '\0') {
    write(fd, gHotUpdaterBundleId, HotUpdaterSafeStringLength(gHotUpdaterBundleId, kHotUpdaterMaxBundleIdLength));
  }
  write(fd, middle, sizeof(middle) - 1);
  if (gHotUpdaterShouldRollback != 0) {
    write(fd, trueLiteral, sizeof(trueLiteral) - 1);
  } else {
    write(fd, falseLiteral, sizeof(falseLiteral) - 1);
  }
  write(fd, suffix, sizeof(suffix) - 1);
  close(fd);
}

void HotUpdaterSignalHandler(int signum, siginfo_t *info, void *context);

void HotUpdaterForwardToPreviousHandler(int signum, siginfo_t *info, void *context)
{
  const struct sigaction &previousAction = gHotUpdaterPreviousActions[signum];

  if ((previousAction.sa_flags & SA_SIGINFO) != 0 && previousAction.sa_sigaction != nullptr &&
      previousAction.sa_sigaction != HotUpdaterSignalHandler) {
    previousAction.sa_sigaction(signum, info, context);
    return;
  }

  if (previousAction.sa_handler == SIG_IGN) {
    return;
  }

  if (previousAction.sa_handler != nullptr && previousAction.sa_handler != SIG_DFL &&
      previousAction.sa_handler != SIG_ERR) {
    previousAction.sa_handler(signum);
    return;
  }

  struct sigaction defaultAction {};
  defaultAction.sa_handler = SIG_DFL;
  sigemptyset(&defaultAction.sa_mask);
  sigaction(signum, &defaultAction, nullptr);
  raise(signum);
}

void HotUpdaterSignalHandler(int signum, siginfo_t *info, void *context)
{
  HotUpdaterWriteCrashMarker();
  HotUpdaterForwardToPreviousHandler(signum, info, context);
}
} // namespace

extern "C" void HotUpdaterInstallSignalHandlers(NSString *crashMarkerPath)
{
  HotUpdaterSafeCopy(gHotUpdaterCrashMarkerPath, sizeof(gHotUpdaterCrashMarkerPath), crashMarkerPath.UTF8String ?: "");

  struct sigaction action {};
  action.sa_sigaction = HotUpdaterSignalHandler;
  action.sa_flags = SA_SIGINFO | SA_ONSTACK;
  sigemptyset(&action.sa_mask);

  for (int signum : kHotUpdaterSignals) {
    sigaction(signum, &action, &gHotUpdaterPreviousActions[signum]);
  }
}

extern "C" void HotUpdaterUpdateSignalLaunchState(NSString * _Nullable bundleId, BOOL shouldRollback)
{
  HotUpdaterSafeCopy(gHotUpdaterBundleId, sizeof(gHotUpdaterBundleId), bundleId.UTF8String ?: "");
  gHotUpdaterShouldRollback = shouldRollback ? 1 : 0;
}

extern "C" BOOL HotUpdaterPerformRecoveryReload(void)
{
  __block BOOL didTriggerReload = NO;

  void (^reloadBlock)(void) = ^{
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl resetLaunchPreparation];

    NSURL *bundleURL = [impl bundleURLWithBundle:[HotUpdaterConfig shared].bundle];
    if (!bundleURL) {
      RCTLogWarn(@"[HotUpdater.mm] Failed to resolve bundle URL for recovery reload");
      return;
    }

    RCTReloadCommandSetBundleURL(bundleURL);
    RCTBridge *bridge = gHotUpdaterBridge;
    if (bridge) {
      [bridge setValue:bundleURL forKey:@"bundleURL"];
    }
    HotUpdaterTriggerReloadCommand(bridge, @"HotUpdater recovery reload");
    didTriggerReload = YES;
  };

  if ([NSThread isMainThread]) {
    reloadBlock();
  } else {
    dispatch_sync(dispatch_get_main_queue(), reloadBlock);
  }

  return didTriggerReload;
}

extern "C" NSString *HotUpdaterGetMinBundleId(void)
{
#if DEBUG
  return @"00000000-0000-0000-0000-000000000000";
#else
  return HotUpdaterBuildMinBundleId();
#endif
}

extern "C" void *HotUpdaterCopyMinBundleId(void)
{
  return (__bridge_retained void *)HotUpdaterGetMinBundleId();
}


// Define Notification names used for observing Swift Core
NSNotificationName const HotUpdaterUpdateProgressDidChangeNotification = @"HotUpdaterUpdateProgressDidChange";

@interface HotUpdaterRecoverySignalBridge : NSObject
@end

@implementation HotUpdaterRecoverySignalBridge

+ (void)installSignalHandlers:(NSString *)crashMarkerPath
{
    HotUpdaterInstallSignalHandlers(crashMarkerPath);
}

+ (void)updateLaunchState:(NSString * _Nullable)bundleId shouldRollback:(BOOL)shouldRollback
{
    HotUpdaterUpdateSignalLaunchState(bundleId, shouldRollback);
}

@end

@interface HotUpdater () <RCTInitializing>
@end

@implementation HotUpdater {
    bool hasListeners;
}

@synthesize bridge = _bridge;
@synthesize moduleRegistry = _moduleRegistry;

+ (BOOL)requiresMainQueueSetup {
    return YES;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleDownloadProgress:)
                                                     name:HotUpdaterUpdateProgressDidChangeNotification
                                                   object:nil];

        _lastUpdateTime = 0;
    }
    return self;
}

- (void)initialize
{
    [self configureExceptionsManagerWithModuleRegistry:self.moduleRegistry];
}

- (void)setBridge:(RCTBridge *)bridge
{
    [super setBridge:bridge];
    gHotUpdaterBridge = bridge;
    [self configureExceptionsManagerWithBridge:bridge];
}

// Clean up observers when module is invalidated or deallocated
- (void)invalidate {
    RCTLogInfo(@"[HotUpdater.mm] invalidate called, removing observers.");
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    if (gHotUpdaterBridge == self.bridge) {
        gHotUpdaterBridge = nil;
    }
    [super invalidate];
}

- (void)dealloc {
    RCTLogInfo(@"[HotUpdater.mm] dealloc called, removing observers.");
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    if (gHotUpdaterBridge == self.bridge) {
        gHotUpdaterBridge = nil;
    }
}

- (void)configureExceptionsManagerWithBridge:(RCTBridge *)bridge
{
    if (!bridge) {
        return;
    }

    id exceptionsManager = [bridge moduleForClass:[RCTExceptionsManager class]];
    [self applyExceptionsManagerReloadLimit:exceptionsManager];
}

- (void)configureExceptionsManagerWithModuleRegistry:(id)moduleRegistry
{
    if (!moduleRegistry || ![moduleRegistry respondsToSelector:@selector(moduleForName:lazilyLoadIfNecessary:)]) {
        return;
    }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    SEL selector = @selector(moduleForName:lazilyLoadIfNecessary:);
    NSMethodSignature *signature = [moduleRegistry methodSignatureForSelector:selector];
    if (!signature) {
        return;
    }

    NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:signature];
    invocation.target = moduleRegistry;
    invocation.selector = selector;

    const char *moduleName = "ExceptionsManager";
    BOOL lazilyLoad = YES;
    [invocation setArgument:&moduleName atIndex:2];
    [invocation setArgument:&lazilyLoad atIndex:3];
    [invocation invoke];

    __unsafe_unretained id exceptionsManager = nil;
    [invocation getReturnValue:&exceptionsManager];
#pragma clang diagnostic pop

    [self applyExceptionsManagerReloadLimit:exceptionsManager];
}

- (void)applyExceptionsManagerReloadLimit:(id)exceptionsManager
{
    if ([exceptionsManager isKindOfClass:[RCTExceptionsManager class]]) {
        ((RCTExceptionsManager *)exceptionsManager).maxReloadAttempts = 0;
    }
}


RCT_EXPORT_MODULE();

#pragma mark - Singleton Instance

// Static singleton HotUpdaterImpl getter
+ (HotUpdaterImpl *)sharedImpl {
    static HotUpdaterImpl *_sharedImpl = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        _sharedImpl = HotUpdaterMakeImpl();
    });
    return _sharedImpl;
}

#pragma mark - React Native Constants (Keep getMinBundleId, delegate others)

// Returns the bundle ID of the bundle this build ships (MIN_BUNDLE_ID)
- (NSString *)getMinBundleId {
     return HotUpdaterGetMinBundleId();
}

- (NSDictionary *)_buildConstantsDictionary {
    return @{
        @"MIN_BUNDLE_ID": [self getMinBundleId] ?: [NSNull null],
        @"APP_VERSION": HotUpdaterAppVersion() ?: [NSNull null],
        @"CHANNEL": [[HotUpdater sharedImpl] getChannel] ?: [NSNull null],
        @"DEFAULT_CHANNEL": [[HotUpdater sharedImpl] getDefaultChannel] ?: [NSNull null],
        @"FINGERPRINT_HASH": [[HotUpdater sharedImpl] getFingerprintHash] ?: [NSNull null]
    };
}


// Get bundleURL with default bundle using singleton
+ (NSURL *)bundleURL {
    return [self bundleURLWithBundle:[NSBundle mainBundle]];
}

// Get bundleURL with specific bundle using singleton
+ (NSURL *)bundleURLWithBundle:(NSBundle *)bundle {
    // Record the bundle before the first sharedImpl, whose storage isolation
    // key reads the bundle's HOT_UPDATER_* Info.plist keys.
    [HotUpdaterConfig shared].bundle = bundle;
    return [[HotUpdater sharedImpl] bundleURLWithBundle:bundle];
}

// Get bundleURL with default bundle using instance impl
- (NSURL *)bundleURL {
    return [HotUpdater bundleURLWithBundle:[NSBundle mainBundle]];
}

// Get bundleURL with specific bundle using instance impl
- (NSURL *)bundleURLWithBundle:(NSBundle *)bundle {
    return [HotUpdater bundleURLWithBundle:bundle];
}

+ (void)configureWithFingerprintHash:(NSString *)fingerprintHash
                           publicKey:(NSString *)publicKey
                             channel:(NSString *)channel
                        isolationKey:(NSString *)isolationKey {
    HotUpdaterConfig *config = HotUpdaterSharedConfig();
    [config configureWithFingerprintHash:fingerprintHash publicKey:publicKey channel:channel isolationKey:isolationKey];
}

+ (HotUpdaterNativeUpdateTask *)checkForUpdate:(HotUpdaterCheckOptions *)options
                                   completion:(void (^)(HotUpdaterUpdate * _Nullable_result, NSError * _Nullable))completion {
    // Before the first sharedImpl, whose storage isolation key reads the
    // bundle's HOT_UPDATER_* Info.plist keys.
    [HotUpdaterConfig shared].bundle = options.bundle;
    return [HotUpdaterNativeUpdateBridge checkForUpdate:options impl:[HotUpdater sharedImpl] completion:completion];
}

+ (HotUpdaterNativeUpdateTask *)prepare:(HotUpdaterCheckOptions *)options
                                timeout:(NSTimeInterval)timeout
                             onProgress:(void (^ _Nullable)(double))onProgress
                             completion:(void (^)(HotUpdaterPrepareResult *))completion {
    [HotUpdaterConfig shared].bundle = options.bundle;
    return [HotUpdaterNativeUpdateBridge prepare:options
                                  timeout:timeout
                                     impl:[HotUpdater sharedImpl]
                               onProgress:onProgress
                               completion:completion];
}

+ (void)resetChannelWithCompletion:(void (^)(BOOL))completion {
    [HotUpdaterNativeUpdateBridge resetChannelWithImpl:[HotUpdater sharedImpl] completion:completion];
}

+ (void)resetChannelWithBundle:(NSBundle *)bundle completion:(void (^)(BOOL))completion {
    // Before the first sharedImpl, whose storage isolation key reads the
    // bundle's HOT_UPDATER_* Info.plist keys.
    [HotUpdaterConfig shared].bundle = bundle;
    [HotUpdaterNativeUpdateBridge resetChannelWithImpl:[HotUpdater sharedImpl] completion:completion];
}

#pragma mark - Progress Updates & Event Emitting (Keep in ObjC Wrapper)

- (void)handleDownloadProgress:(NSNotification *)notification {
     if (!hasListeners) return;

     NSDictionary *userInfo = notification.userInfo;
     NSNumber *progressNum = userInfo[@"progress"];

     if (progressNum) {
         double progress = [progressNum doubleValue];
         NSTimeInterval currentTime = [[NSDate date] timeIntervalSince1970] * 1000;
         if ((currentTime - self.lastUpdateTime) >= 100 || progress >= 1.0) {
             self.lastUpdateTime = currentTime;
             [self sendEvent:@"onProgress" body:userInfo ?: @{}];
         }
     }
 }

#pragma mark - React Native Events (Keep as is)

- (NSArray<NSString *> *)supportedEvents {
    return @[@"onProgress"];
}

- (void)startObserving {
    hasListeners = YES;
}

- (void)stopObserving {
    hasListeners = NO;
}

- (void)sendEvent:(NSString *)name body:(id)body {
    if (hasListeners) {
        [self sendEventWithName:name body:body];
    }
}


#pragma mark - React Native Exports

#ifdef RCT_NEW_ARCH_ENABLED

// New Architecture implementations

- (void)reload:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject {
    RCTLogInfo(@"[HotUpdater.mm] HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            HotUpdaterImpl *impl = [HotUpdater sharedImpl];
            [impl resetLaunchPreparation];
            NSURL *bundleURL = [impl bundleURLWithBundle:[HotUpdaterConfig shared].bundle];
            RCTLogInfo(@"[HotUpdater.mm] Reloading with bundle URL: %@", bundleURL);
            if (bundleURL) {
                RCTReloadCommandSetBundleURL(bundleURL);
            }
            if (bundleURL && super.bridge) {
                [super.bridge setValue:bundleURL forKey:@"bundleURL"];
            } else if (!super.bridge) {
                RCTLogWarn(@"[HotUpdater.mm] Bridge is nil, cannot set bundleURL for reload.");
            }
            HotUpdaterTriggerReloadCommand(super.bridge, @"HotUpdater requested a reload");
            resolve(nil);
        } @catch (NSError *error) {
            RCTLogError(@"[HotUpdater.mm] Failed to reload: %@", error);
            reject(@"RELOAD_ERROR", error.description, error);
        }
    });
}

- (void)reloadProcess:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
    [self reload:resolve reject:reject];
}

- (void)updateBundle:(JS::NativeHotUpdater::UpdateBundleParams &)params
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
    NSLog(@"[HotUpdater.mm] updateBundle called.");
    NSMutableDictionary *paramDict = [NSMutableDictionary dictionary];
    if (params.bundleId()) {
        paramDict[@"bundleId"] = params.bundleId();
    }
    if (params.manifestUrl()) {
        paramDict[@"manifestUrl"] = params.manifestUrl();
    }
    if (params.manifestFileHash()) {
        paramDict[@"manifestFileHash"] = params.manifestFileHash();
    }
    if (params.archiveUrl()) {
        paramDict[@"archiveUrl"] = params.archiveUrl();
    }
    if (params.assets()) {
        paramDict[@"assets"] = params.assets();
    }
    if (params.channel()) {
        paramDict[@"channel"] = params.channel();
    }
    if (params.selection()) {
        paramDict[@"selection"] = params.selection();
    }

    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl updateBundle:paramDict resolver:resolve rejecter:reject];
}

- (NSNumber *)acceptReleaseCatalog:(NSDictionary *)params {
    return @([[HotUpdater sharedImpl] acceptReleaseCatalog:params]);
}

- (NSDictionary *)getActiveUpdateState {
    return [[HotUpdater sharedImpl] getActiveUpdateState];
}

- (void)getReleaseCatalogCache:(NSString *)partition
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject {
    [[HotUpdater sharedImpl] getReleaseCatalogCache:partition resolver:resolve rejecter:reject];
}

- (void)setReleaseCatalogCache:(NSString *)partition
                       payload:(NSString *)payload
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
    [[HotUpdater sharedImpl] setReleaseCatalogCache:partition payload:payload resolver:resolve rejecter:reject];
}

- (void)removeReleaseCatalogCache:(NSString *)partition
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
    [[HotUpdater sharedImpl] removeReleaseCatalogCache:partition resolver:resolve rejecter:reject];
}

- (NSNumber *)isReleaseSelectionCurrent:(NSDictionary *)params {
    return @([[HotUpdater sharedImpl] isReleaseSelectionCurrent:params]);
}

- (void)commitReleaseSelection:(NSDictionary *)params
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
    [[HotUpdater sharedImpl] commitReleaseSelection:params resolver:resolve rejecter:reject];
}

- (NSDictionary *)notifyAppReady {
    NSLog(@"[HotUpdater.mm] notifyAppReady called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl notifyAppReady];
}

- (NSArray<NSString *> *)getCrashHistory {
    NSLog(@"[HotUpdater.mm] getCrashHistory called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    NSArray<NSString *> *crashHistory = [impl getCrashHistory];
    return crashHistory ?: @[];
}

- (NSNumber *)clearCrashHistory {
    NSLog(@"[HotUpdater.mm] clearCrashHistory called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    BOOL result = [impl clearCrashHistory];
    return @(result);
}

- (NSString *)getInstallId {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getInstallId];
}

- (NSString * _Nullable)getStorageItem:(NSString *)key {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getStorageItem:key];
}

- (void)setStorageItem:(NSString *)key value:(NSString * _Nullable)value {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl setStorageItem:key value:value];
}

- (NSString * _Nullable)takeNativeUpdateEvents {
    return [HotUpdaterNativeUpdateBridge takeEventsWithImpl:[HotUpdater sharedImpl]];
}

- (NSString * _Nullable)getBaseURL {
    NSLog(@"[HotUpdater.mm] getBaseURL called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getBaseURL];
}

- (void)setCohort:(NSString *)customId {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl setCohort:customId];
}

- (NSString *)getCohort {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getCohort];
}

- (NSString * _Nullable)getBundleId {
    NSLog(@"[HotUpdater.mm] getBundleId called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getBundleId];
}

- (NSDictionary<NSString *, id> *)getManifest {
    NSLog(@"[HotUpdater.mm] getManifest called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    NSDictionary<NSString *, id> *manifest = [impl getManifest];
    return manifest ?: @{};
}

- (void)resetChannel:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
    [HotUpdaterNativeUpdateBridge resetChannelWithImpl:[HotUpdater sharedImpl]
                                              resolver:resolve
                                              rejecter:reject];
}

- (facebook::react::ModuleConstants<JS::NativeHotUpdater::Constants::Builder>)constantsToExport {
    return [self getConstants];
}

- (facebook::react::ModuleConstants<JS::NativeHotUpdater::Constants::Builder>)getConstants {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return facebook::react::typedConstants<JS::NativeHotUpdater::Constants::Builder>({
        .MIN_BUNDLE_ID = [self getMinBundleId],
        .APP_VERSION = HotUpdaterAppVersion(),
        .CHANNEL = [impl getChannel],
        .DEFAULT_CHANNEL = [impl getDefaultChannel],
        .FINGERPRINT_HASH = [impl getFingerprintHash],
    });
}

#else

// Old Architecture implementations

RCT_EXPORT_METHOD(reload:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    RCTLogInfo(@"[HotUpdater.mm] HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            HotUpdaterImpl *impl = [HotUpdater sharedImpl];
            [impl resetLaunchPreparation];
            NSURL *bundleURL = [impl bundleURLWithBundle:[HotUpdaterConfig shared].bundle];
            RCTLogInfo(@"[HotUpdater.mm] Reloading with bundle URL: %@", bundleURL);
            if (bundleURL) {
                RCTReloadCommandSetBundleURL(bundleURL);
            }
            if (bundleURL && super.bridge) {
                [super.bridge setValue:bundleURL forKey:@"bundleURL"];
            } else if (!super.bridge) {
                RCTLogWarn(@"[HotUpdater.mm] Bridge is nil, cannot set bundleURL for reload.");
            }
            HotUpdaterTriggerReloadCommand(super.bridge, @"HotUpdater requested a reload");
            resolve(nil);
        } @catch (NSError *error) {
            RCTLogError(@"[HotUpdater.mm] Failed to reload: %@", error);
            reject(@"RELOAD_ERROR", error.description, error);
        }
    });
}

RCT_EXPORT_METHOD(reloadProcess:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [self reload:resolve reject:reject];
}

RCT_EXPORT_METHOD(updateBundle:(NSDictionary *)params
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    NSLog(@"[HotUpdater.mm] updateBundle called. params: %@", params);
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl updateBundle:params resolver:resolve rejecter:reject];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(acceptReleaseCatalog:(NSDictionary *)params) {
    return @([[HotUpdater sharedImpl] acceptReleaseCatalog:params]);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getActiveUpdateState) {
    return [[HotUpdater sharedImpl] getActiveUpdateState];
}

RCT_EXPORT_METHOD(getReleaseCatalogCache:(NSString *)partition
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[HotUpdater sharedImpl] getReleaseCatalogCache:partition resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(setReleaseCatalogCache:(NSString *)partition
                  payload:(NSString *)payload
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[HotUpdater sharedImpl] setReleaseCatalogCache:partition payload:payload resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(removeReleaseCatalogCache:(NSString *)partition
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[HotUpdater sharedImpl] removeReleaseCatalogCache:partition resolver:resolve rejecter:reject];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(isReleaseSelectionCurrent:(NSDictionary *)params) {
    return @([[HotUpdater sharedImpl] isReleaseSelectionCurrent:params]);
}

RCT_EXPORT_METHOD(commitReleaseSelection:(NSDictionary *)params
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[HotUpdater sharedImpl] commitReleaseSelection:params resolver:resolve rejecter:reject];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(notifyAppReady) {
    NSLog(@"[HotUpdater.mm] notifyAppReady called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl notifyAppReady];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getCrashHistory) {
    NSLog(@"[HotUpdater.mm] getCrashHistory called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    NSArray<NSString *> *crashHistory = [impl getCrashHistory];
    return crashHistory ?: @[];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(clearCrashHistory) {
    NSLog(@"[HotUpdater.mm] clearCrashHistory called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    BOOL result = [impl clearCrashHistory];
    return @(result);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getInstallId) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getInstallId];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getStorageItem:(NSString *)key) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getStorageItem:key];
}

RCT_EXPORT_METHOD(setStorageItem:(NSString *)key value:(NSString * _Nullable)value) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl setStorageItem:key value:value];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(takeNativeUpdateEvents) {
    return [HotUpdaterNativeUpdateBridge takeEventsWithImpl:[HotUpdater sharedImpl]];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getBaseURL) {
    NSLog(@"[HotUpdater.mm] getBaseURL called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getBaseURL];
}

RCT_EXPORT_METHOD(setCohort:(NSString *)customId) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl setCohort:customId];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getCohort) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getCohort];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getBundleId) {
    NSLog(@"[HotUpdater.mm] getBundleId called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getBundleId];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getManifest) {
    NSLog(@"[HotUpdater.mm] getManifest called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    NSDictionary<NSString *, id> *manifest = [impl getManifest];
    return manifest ?: @{};
}

RCT_EXPORT_METHOD(resetChannel:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [HotUpdaterNativeUpdateBridge resetChannelWithImpl:[HotUpdater sharedImpl]
                                              resolver:resolve
                                              rejecter:reject];
}

- (NSDictionary *)constantsToExport {
    return [self _buildConstantsDictionary];
}

- (NSDictionary *)getConstants {
    return [self constantsToExport];
}

#endif


#pragma mark - Turbo Module Support (Keep as is)


#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
    return std::make_shared<facebook::react::NativeHotUpdaterSpecJSI>(params);
}
#endif


@end
