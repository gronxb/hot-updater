#import "HotUpdater.h"
#import <React/RCTReloadCommand.h>
#import <React/RCTLog.h>


#if __has_include("HotUpdater/HotUpdater-Swift.h")
#import "HotUpdater/HotUpdater-Swift.h"
#else
#import "HotUpdater-Swift.h"
#endif


// Define Notification names used for observing Swift Core
NSNotificationName const HotUpdaterDownloadProgressUpdateNotification = @"HotUpdaterDownloadProgressUpdate";
NSNotificationName const HotUpdaterDownloadDidFinishNotification = @"HotUpdaterDownloadDidFinish";

@implementation HotUpdater {
    bool hasListeners;
    // Keep track of tasks ONLY for removing observers when this ObjC instance is invalidated
    NSMutableSet<NSURLSessionTask *> *observedTasks; // Changed to NSURLSessionTask for broader compatibility if needed
}

+ (BOOL)requiresMainQueueSetup {
    return YES;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        observedTasks = [NSMutableSet set];

        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleDownloadProgress:)
                                                     name:HotUpdaterDownloadProgressUpdateNotification
                                                   object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleDownloadCompletion:)
                                                     name:HotUpdaterDownloadDidFinishNotification
                                                   object:nil];

        _lastUpdateTime = 0;
    }
    return self;
}

// Clean up observers when module is invalidated or deallocated
- (void)invalidate {
    RCTLogInfo(@"[HotUpdater.mm] invalidate called, removing observers.");
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    // Swift side should handle KVO observer removal for its tasks
    [super invalidate];
}

- (void)dealloc {
    RCTLogInfo(@"[HotUpdater.mm] dealloc called, removing observers.");
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}


RCT_EXPORT_MODULE();

#pragma mark - Singleton Instance

// Static singleton HotUpdaterImpl getter
+ (HotUpdaterImpl *)sharedImpl {
    static HotUpdaterImpl *_sharedImpl = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        _sharedImpl = [[HotUpdaterImpl alloc] init];
    });
    return _sharedImpl;
}

#pragma mark - React Native Constants (Keep getMinBundleId, delegate others)

// Returns the minimum bundle ID string, either from Info.plist or generated from build timestamp
- (NSString *)getMinBundleId {
     static NSString *uuid = nil;
     static dispatch_once_t onceToken;
     dispatch_once(&onceToken, ^{
     #if DEBUG
         uuid = @"00000000-0000-0000-0000-000000000000";
     #else
         // Step 1: Try to read HOT_UPDATER_BUILD_TIMESTAMP from Info.plist
         NSDictionary *infoDictionary = [[NSBundle mainBundle] infoDictionary];
         NSString *customValue = infoDictionary[@"HOT_UPDATER_BUILD_TIMESTAMP"];

         // Step 2: If custom value exists and is not empty
         if (customValue && customValue.length > 0 && ![customValue isEqualToString:@"$(HOT_UPDATER_BUILD_TIMESTAMP)"]) {
             // Check if it's a timestamp (pure digits) or UUID
             NSCharacterSet *nonDigits = [[NSCharacterSet decimalDigitCharacterSet] invertedSet];
             BOOL isTimestamp = ([customValue rangeOfCharacterFromSet:nonDigits].location == NSNotFound);

             if (isTimestamp) {
                 // Convert timestamp (milliseconds) to UUID v7
                 uint64_t timestampMs = [customValue longLongValue];
                 uuid = [self generateUUIDv7FromTimestamp:timestampMs];
                 RCTLogInfo(@"[HotUpdater.mm] Using timestamp %@ as MIN_BUNDLE_ID: %@", customValue, uuid);
             } else {
                 // Use as UUID directly
                 uuid = customValue;
                 RCTLogInfo(@"[HotUpdater.mm] Using custom MIN_BUNDLE_ID from Info.plist: %@", uuid);
             }
             return;
         }

         // Step 3: Fallback to default logic (26-hour subtraction)
         RCTLogInfo(@"[HotUpdater.mm] No custom MIN_BUNDLE_ID found, using default calculation");

         NSString *compileDateStr = [NSString stringWithFormat:@"%s %s", __DATE__, __TIME__];
         NSDateFormatter *formatter = [[NSDateFormatter alloc] init];

         // Parse __DATE__ __TIME__ as UTC to ensure consistent timezone handling across all build environments
         [formatter setTimeZone:[NSTimeZone timeZoneWithName:@"UTC"]];
         [formatter setLocale:[[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"]];
         [formatter setDateFormat:@"MMM d yyyy HH:mm:ss"]; // Correct format for __DATE__ __TIME__
         NSDate *buildDate = [formatter dateFromString:compileDateStr];
         if (!buildDate) {
             RCTLogWarn(@"[HotUpdater.mm] Could not parse build date: %@", compileDateStr);
             uuid = @"00000000-0000-0000-0000-000000000000";
             return;
         }

         // Subtract 26 hours (93600 seconds) to ensure MIN_BUNDLE_ID is always in the past
         // This guarantees that uuidv7-based bundleIds (generated at runtime) will always be newer than MIN_BUNDLE_ID
         // Why 26 hours? Global timezone range spans from UTC-12 to UTC+14 (total 26 hours)
         // By subtracting 26 hours, MIN_BUNDLE_ID becomes a safe "past timestamp" regardless of build timezone
         // Example: Build at 15:00 in any timezone → parse as 15:00 UTC → subtract 26h → 13:00 UTC (previous day)
         NSTimeInterval adjustedTimestamp = [buildDate timeIntervalSince1970] - 93600.0;
         uint64_t buildTimestampMs = (uint64_t)(adjustedTimestamp * 1000.0);

         uuid = [self generateUUIDv7FromTimestamp:buildTimestampMs];
     #endif
     });
     return uuid;
}

// Helper method: Generate UUID v7 from timestamp (milliseconds)
- (NSString *)generateUUIDv7FromTimestamp:(uint64_t)timestampMs {
    unsigned char bytes[16];

    // UUID v7 format: timestamp_ms (48 bits) + ver (4 bits) + random (12 bits) + variant (2 bits) + random (62 bits)
    bytes[0] = (timestampMs >> 40) & 0xFF;
    bytes[1] = (timestampMs >> 32) & 0xFF;
    bytes[2] = (timestampMs >> 24) & 0xFF;
    bytes[3] = (timestampMs >> 16) & 0xFF;
    bytes[4] = (timestampMs >> 8) & 0xFF;
    bytes[5] = timestampMs & 0xFF;

    // Version 7
    bytes[6] = 0x70;
    bytes[7] = 0x00;

    // Variant bits (10xxxxxx)
    bytes[8] = 0x80;
    bytes[9] = 0x00;

    // Remaining bytes (zeros for deterministic MIN_BUNDLE_ID)
    for (int i = 10; i < 16; i++) {
        bytes[i] = 0x00;
    }

    return [NSString stringWithFormat:
            @"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]];
}


- (NSDictionary *)_buildConstantsDictionary {
    return @{
        @"MIN_BUNDLE_ID": [self getMinBundleId] ?: [NSNull null],
        @"APP_VERSION": [HotUpdaterImpl appVersion] ?: [NSNull null],
        @"CHANNEL": [[HotUpdater sharedImpl] getChannel] ?: [NSNull null],
        @"FINGERPRINT_HASH": [[HotUpdater sharedImpl] getFingerprintHash] ?: [NSNull null]
    };
}


// Get bundleURL using singleton
+ (NSURL *)bundleURL {
    return [[HotUpdater sharedImpl] bundleURL];
}

// Get bundleURL using instance impl
- (NSURL *)bundleURL {
    return [[HotUpdater sharedImpl] bundleURL];
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
             [self sendEvent:@"onProgress" body:@{@"progress": @(progress)}];
         }
     }
 }

- (void)handleDownloadCompletion:(NSNotification *)notification {
      NSURLSessionTask *task = notification.object; // Task that finished
      RCTLogInfo(@"[HotUpdater.mm] Received download completion notification for task: %@", task.originalRequest.URL);
      // Swift side handles KVO observer removal internally now when task finishes.
      // No specific cleanup needed here based on this notification anymore.
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
            NSURL *bundleURL = [impl bundleURL];
            RCTLogInfo(@"[HotUpdater.mm] Reloading with bundle URL: %@", bundleURL);
            if (bundleURL && super.bridge) {
                [super.bridge setValue:bundleURL forKey:@"bundleURL"];
            } else if (!super.bridge) {
                RCTLogWarn(@"[HotUpdater.mm] Bridge is nil, cannot set bundleURL for reload.");
            }
            RCTTriggerReloadCommandListeners(@"HotUpdater requested a reload");
            resolve(nil);
        } @catch (NSError *error) {
            RCTLogError(@"[HotUpdater.mm] Failed to reload: %@", error);
            reject(@"RELOAD_ERROR", error.description, error);
        }
    });
}

- (void)updateBundle:(JS::NativeHotUpdater::UpdateBundleParams &)params
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
    NSLog(@"[HotUpdater.mm] updateBundle called.");
    NSMutableDictionary *paramDict = [NSMutableDictionary dictionary];
    if (params.bundleId()) {
        paramDict[@"bundleId"] = params.bundleId();
    }
    if (params.fileUrl()) {
        paramDict[@"fileUrl"] = params.fileUrl();
    }
    if (params.fileHash()) {
        paramDict[@"fileHash"] = params.fileHash();
    }

    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl updateBundle:paramDict resolver:resolve rejecter:reject];
}

- (NSDictionary *)notifyAppReady:(JS::NativeHotUpdater::SpecNotifyAppReadyParams &)params {
    NSString *bundleId = nil;
    if (params.bundleId()) {
        bundleId = params.bundleId();
    }
    NSLog(@"[HotUpdater.mm] notifyAppReady called with bundleId: %@", bundleId);
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl notifyAppReadyWithBundleId:bundleId];
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

- (NSString *)getBaseURL {
    NSLog(@"[HotUpdater.mm] getBaseURL called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    NSString *baseURL = [impl getBaseURL];
    return baseURL ?: @"";
}

- (void)setUserId:(NSString *)customId {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl setUserId:customId];
}

- (NSString *)getUserId {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getUserId];
}


- (facebook::react::ModuleConstants<JS::NativeHotUpdater::Constants::Builder>)constantsToExport {
    return [self getConstants];
}

- (facebook::react::ModuleConstants<JS::NativeHotUpdater::Constants::Builder>)getConstants {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return facebook::react::typedConstants<JS::NativeHotUpdater::Constants::Builder>({
        .MIN_BUNDLE_ID = [self getMinBundleId],
        .APP_VERSION = [HotUpdaterImpl appVersion],
        .CHANNEL = [impl getChannel],
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
            NSURL *bundleURL = [impl bundleURL];
            RCTLogInfo(@"[HotUpdater.mm] Reloading with bundle URL: %@", bundleURL);
            if (bundleURL && super.bridge) {
                [super.bridge setValue:bundleURL forKey:@"bundleURL"];
            } else if (!super.bridge) {
                RCTLogWarn(@"[HotUpdater.mm] Bridge is nil, cannot set bundleURL for reload.");
            }
            RCTTriggerReloadCommandListeners(@"HotUpdater requested a reload");
            resolve(nil);
        } @catch (NSError *error) {
            RCTLogError(@"[HotUpdater.mm] Failed to reload: %@", error);
            reject(@"RELOAD_ERROR", error.description, error);
        }
    });
}

RCT_EXPORT_METHOD(updateBundle:(NSDictionary *)params
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    NSLog(@"[HotUpdater.mm] updateBundle called. params: %@", params);
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl updateBundle:params resolver:resolve rejecter:reject];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(notifyAppReady:(NSDictionary *)params) {
    NSString *bundleId = params[@"bundleId"];
    NSLog(@"[HotUpdater.mm] notifyAppReady called with bundleId: %@", bundleId);
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl notifyAppReadyWithBundleId:bundleId];
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

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getBaseURL) {
    NSLog(@"[HotUpdater.mm] getBaseURL called");
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    NSString *baseURL = [impl getBaseURL];
    return baseURL ?: @"";
}

RCT_EXPORT_METHOD(setUserId:(NSString *)customId) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl setUserId:customId];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getUserId) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getUserId];
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
