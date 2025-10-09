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

// Create static HotUpdaterImpl instance
static HotUpdaterImpl *_hotUpdaterImpl = [HotUpdaterFactory.shared create];

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
        
        // Start observing notifications needed for cleanup/events
        // Using self as observer
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleDownloadProgress:)
                                                     name:HotUpdaterDownloadProgressUpdateNotification
                                                   object:nil]; // Observe all tasks from Impl
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleDownloadCompletion:)
                                                     name:HotUpdaterDownloadDidFinishNotification
                                                   object:nil]; // Observe all tasks from Impl

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

#pragma mark - React Native Constants (Keep getMinBundleId, delegate others)

// Keep local implementation if complex or uses macros
- (NSString *)getMinBundleId {
     static NSString *uuid = nil;
     static dispatch_once_t onceToken;
     dispatch_once(&onceToken, ^{
     #if DEBUG
         uuid = @"00000000-0000-0000-0000-000000000000";
     #else
         NSString *compileDateStr = [NSString stringWithFormat:@"%s %s", __DATE__, __TIME__];
         NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
         [formatter setLocale:[[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"]];
         [formatter setDateFormat:@"MMM d yyyy HH:mm:ss"]; // Correct format for __DATE__ __TIME__
         NSDate *buildDate = [formatter dateFromString:compileDateStr];
         if (!buildDate) {
             RCTLogWarn(@"[HotUpdater.mm] Could not parse build date: %@", compileDateStr);
             uuid = @"00000000-0000-0000-0000-000000000000";
             return;
         }
         uint64_t buildTimestampMs = (uint64_t)([buildDate timeIntervalSince1970] * 1000.0);
         unsigned char bytes[16];
         bytes[0] = (buildTimestampMs >> 40) & 0xFF; // ... rest of UUID logic ...
         bytes[1] = (buildTimestampMs >> 32) & 0xFF;
         bytes[2] = (buildTimestampMs >> 24) & 0xFF;
         bytes[3] = (buildTimestampMs >> 16) & 0xFF;
         bytes[4] = (buildTimestampMs >> 8) & 0xFF;
         bytes[5] = buildTimestampMs & 0xFF;
         bytes[6] = 0x70; bytes[7] = 0x00; bytes[8] = 0x80; bytes[9] = 0x00;
         bytes[10] = 0x00; bytes[11] = 0x00; bytes[12] = 0x00; bytes[13] = 0x00; bytes[14] = 0x00; bytes[15] = 0x00;
         uuid = [NSString stringWithFormat:
                 @"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                 bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                 bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]];
     #endif
     });
     return uuid;
}


- (NSDictionary *)constantsToExport {
    return @{
        @"MIN_BUNDLE_ID": [self getMinBundleId] ?: [NSNull null], // Local
        @"APP_VERSION": [HotUpdaterImpl appVersion] ?: [NSNull null], // Swift
        @"CHANNEL": [_hotUpdaterImpl getChannel] ?: [NSNull null], // Swift
        @"FINGERPRINT_HASH": [_hotUpdaterImpl getFingerprintHash] ?: [NSNull null] // Swift
    };
}

- (NSDictionary *)getConstants {
 return [self constantsToExport];
}


// Get bundleURL using static instance
+ (NSURL *)bundleURL {
    return [_hotUpdaterImpl bundleURL];
}


#pragma mark - Progress Updates & Event Emitting (Keep in ObjC Wrapper)

- (void)handleDownloadProgress:(NSNotification *)notification {
     if (!hasListeners) return;

     NSDictionary *userInfo = notification.userInfo;
     NSNumber *progressNum = userInfo[@"progress"];

     if (progressNum) {
         double progress = [progressNum doubleValue];
         NSTimeInterval currentTime = [[NSDate date] timeIntervalSince1970] * 1000;
         // Throttle events
         if ((currentTime - self.lastUpdateTime) >= 100 || progress >= 1.0) {
             self.lastUpdateTime = currentTime;
             // RCTLogInfo(@"[HotUpdater.mm] Sending progress event: %.2f", progress); // Reduce log noise
             [self sendEventWithName:@"onProgress" body:@{@"progress": @(progress)}];
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
    RCTLogInfo(@"[HotUpdater.mm] Start observing JS events.");
    // Observers are added in init now
}

- (void)stopObserving {
    hasListeners = NO;
    RCTLogInfo(@"[HotUpdater.mm] Stop observing JS events.");
    // Observers are removed in invalidate/dealloc
}

- (void)sendEventWithName:(NSString * _Nonnull)name body:(id)body { // Changed body type to id
    if (hasListeners) {
        [super sendEventWithName:name body:body];
    }
}


#pragma mark - React Native Exports (Slimmed Down)

// Keep reload logic here as it interacts with RN Bridge
RCT_EXPORT_METHOD(reload:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    RCTLogInfo(@"[HotUpdater.mm] HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            // Get bundleURL using static instance
            NSURL *bundleURL = [_hotUpdaterImpl bundleURL];
            RCTLogInfo(@"[HotUpdater.mm] Reloading with bundle URL: %@", bundleURL);
            if (bundleURL && super.bridge) {
                // This method of setting bundleURL might be outdated depending on RN version.
                // Consider alternatives if this doesn't work reliably.
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

#ifdef RCT_NEW_ARCH_ENABLED

RCT_EXPORT_METHOD(updateBundle:(JS::NativeHotUpdater::UpdateBundleParams &)params
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    NSLog(@"[HotUpdater.mm] updateBundle called.");
    NSMutableDictionary *paramDict = [NSMutableDictionary dictionary];
    if (params.bundleId()) {
        paramDict[@"bundleId"] = params.bundleId();
    }
    if (params.fileUrl()) {
        paramDict[@"fileUrl"] = params.fileUrl();
    }
    
    [_hotUpdaterImpl updateBundle:paramDict resolver:resolve rejecter:reject];
}
#else
RCT_EXPORT_METHOD(updateBundle:(NSDictionary *)params
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    NSLog(@"[HotUpdater.mm] updateBundle called. params: %@", params);
    [_hotUpdaterImpl updateBundle:params resolver:resolve rejecter:reject];
}
#endif




#pragma mark - Turbo Module Support (Keep as is)


#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
    return std::make_shared<facebook::react::NativeHotUpdaterSpecJSI>(params);
}
#endif


@end
