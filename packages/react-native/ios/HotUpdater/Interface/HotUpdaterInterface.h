#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

// Swift Package Manager builds HotUpdater's Swift implementation as its own
// target, and HotUpdater.mm (Objective-C++) can't import that target's
// generated header: it is reachable only as a Clang module, and React
// Native's headers don't build as C++ modules. HotUpdater.mm calls the Swift
// classes through these protocols instead, and the Swift classes conform to
// them in HotUpdaterInterface.swift, so the compiler checks both sides.
// CocoaPods builds import HotUpdater-Swift.h and don't use this file.

NS_ASSUME_NONNULL_BEGIN

@protocol HotUpdaterImplInterface <NSObject>
- (NSString *)getChannel;
- (NSString *)getDefaultChannel;
- (nullable NSString *)getFingerprintHash;
- (void)setCohort:(NSString *)cohort;
- (NSString *)getCohort;
- (nullable NSURL *)bundleURLWithBundle:(NSBundle *)bundle NS_SWIFT_NAME(bundleURL(bundle:));
- (void)updateBundle:(nullable NSDictionary *)params
            resolver:(RCTPromiseResolveBlock)resolve
            rejecter:(RCTPromiseRejectBlock)reject;
- (void)installArtifact:(nullable NSDictionary *)params
               resolver:(RCTPromiseResolveBlock)resolve
               rejecter:(RCTPromiseRejectBlock)reject;
- (BOOL)acceptReleaseCatalog:(nullable NSDictionary *)params;
- (NSDictionary<NSString *, id> *)getActiveUpdateState;
- (void)getReleaseCatalogCache:(NSString *)partition
                      resolver:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject;
- (void)setReleaseCatalogCache:(NSString *)partition
                       payload:(NSString *)payload
                      resolver:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject;
- (void)removeReleaseCatalogCache:(NSString *)partition
                         resolver:(RCTPromiseResolveBlock)resolve
                         rejecter:(RCTPromiseRejectBlock)reject;
- (BOOL)isReleaseSelectionCurrent:(nullable NSDictionary *)params;
- (void)commitReleaseSelection:(nullable NSDictionary *)params
                      resolver:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject;
- (NSDictionary<NSString *, id> *)notifyAppReady;
- (NSArray<NSString *> *)getCrashHistory;
- (BOOL)clearCrashHistory;
- (NSString *)getInstallId;
- (nullable NSString *)getStorageItem:(NSString *)key;
- (void)setStorageItem:(NSString *)key value:(nullable NSString *)value;
- (nullable NSString *)getBaseURL;
- (nullable NSString *)getBundleId;
- (NSDictionary<NSString *, id> *)getManifest;
- (void)resetLaunchPreparation;
- (void)resetChannel:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (void)resetChannelIfSelectionCurrent:(nullable NSDictionary *)params
                              resolver:(RCTPromiseResolveBlock)resolve
                              rejecter:(RCTPromiseRejectBlock)reject;
@end

@protocol HotUpdaterConfigInterface <NSObject>
@property (nonatomic, strong) NSBundle *bundle;
- (void)configureWithFingerprintHash:(nullable NSString *)fingerprintHash
                           publicKey:(nullable NSString *)publicKey
                             channel:(nullable NSString *)channel
                        isolationKey:(nullable NSString *)isolationKey
    NS_SWIFT_NAME(configureWithFingerprintHash(_:publicKey:channel:isolationKey:));
@end

// The TurboModule's channel reset and event replay, which go through the
// Swift native update check, and the impl of the runtime that runs a bundle.
@protocol HotUpdaterNativeUpdatesInterface <NSObject>
- (void)resetChannelWithImpl:(id<HotUpdaterImplInterface>)impl
                    resolver:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject;
- (void)resetChannelIfSelectionCurrentWithImpl:(id<HotUpdaterImplInterface>)impl
                                        params:(nullable NSDictionary *)params
                                      resolver:(RCTPromiseResolveBlock)resolve
                                      rejecter:(RCTPromiseRejectBlock)reject;
- (nullable NSString *)takeEventsWithImpl:(id<HotUpdaterImplInterface>)impl;
- (id<HotUpdaterImplInterface>)implForBundleURL:(nullable NSURL *)bundleURL
    NS_SWIFT_NAME(impl(forBundleURL:));
@end

// Implemented in HotUpdaterInterface.swift.
FOUNDATION_EXTERN id<HotUpdaterImplInterface> HotUpdaterMakeImpl(void);
FOUNDATION_EXTERN NSString *_Nullable HotUpdaterAppVersion(void);
FOUNDATION_EXTERN id<HotUpdaterConfigInterface> HotUpdaterSharedConfig(void);
FOUNDATION_EXTERN id<HotUpdaterNativeUpdatesInterface> HotUpdaterNativeUpdates(void);

NS_ASSUME_NONNULL_END
