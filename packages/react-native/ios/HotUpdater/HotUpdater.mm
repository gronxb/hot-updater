#import "HotUpdater.h"
#import "HotUpdaterPrefs.h"
#import <React/RCTReloadCommand.h>
#import <SSZipArchive/SSZipArchive.h>
#import <Foundation/NSURLSession.h>

@implementation HotUpdater {
    bool hasListeners;
}

+ (BOOL)requiresMainQueueSetup {
    return YES;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _lastUpdateTime = 0;
    }
    return self;
}

RCT_EXPORT_MODULE();

#pragma mark - React Native Constants

- (NSString *)getMinBundleId {
    static NSString *uuid = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
    #if DEBUG
        uuid = @"00000000-0000-0000-0000-000000000000";
        return;
    #else
        // __DATE__, __TIME__ is compile-time
        NSString *compileDateStr = [NSString stringWithFormat:@"%s %s", __DATE__, __TIME__];
        NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
        [formatter setDateFormat:@"MMM d yyyy HH:mm:ss"];
        NSDate *buildDate = [formatter dateFromString:compileDateStr];
        if (!buildDate) {
            uuid = @"00000000-0000-0000-0000-000000000000";
            return;
        }

        uint64_t buildTimestampMs = (uint64_t)([buildDate timeIntervalSince1970] * 1000.0);
        unsigned char bytes[16];
        bytes[0] = (buildTimestampMs >> 40) & 0xFF;
        bytes[1] = (buildTimestampMs >> 32) & 0xFF;
        bytes[2] = (buildTimestampMs >> 24) & 0xFF;
        bytes[3] = (buildTimestampMs >> 16) & 0xFF;
        bytes[4] = (buildTimestampMs >> 8) & 0xFF;
        bytes[5] = buildTimestampMs & 0xFF;

        bytes[6] = 0x70;
        bytes[7] = 0x00;

        bytes[8] = 0x80;
        bytes[9] = 0x00;

        bytes[10] = 0x00;
        bytes[11] = 0x00;
        bytes[12] = 0x00;
        bytes[13] = 0x00;
        bytes[14] = 0x00;
        bytes[15] = 0x00;

        uuid = [NSString stringWithFormat:
                @"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                bytes[0], bytes[1], bytes[2], bytes[3],
                bytes[4], bytes[5],
                bytes[6], bytes[7],
                bytes[8], bytes[9],
                bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]];
    #endif
    });
    return uuid;
}

- (NSString *)getChannel {
    HotUpdaterPrefs *prefs = [self getPrefs];
    return [prefs getItemForKey:@"HotUpdaterChannel"];
}

- (NSString *)getAppVersion {
    NSString *appVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    return appVersion;
}

- (NSDictionary *)constantsToExport {
    return @{
        @"MIN_BUNDLE_ID": [self getMinBundleId] ?: [NSNull null],
        @"APP_VERSION": [self getAppVersion] ?: [NSNull null],
        @"CHANNEL": [self getChannel] ?: [NSNull null]
    };
}

- (NSDictionary *)getConstants {
  return [self constantsToExport];
}

#pragma mark - Convenience: HotUpdaterPrefs Instance

- (HotUpdaterPrefs *)getPrefs {
    return [HotUpdaterPrefs sharedInstanceWithAppVersion:[self getAppVersion]];
}

#pragma mark - Method init execution count

static NSInteger executionCount = 0;

+ (void)incrementExecutionCount {
    executionCount++;
}

#pragma mark - Bundle URL Management

+ (void)setChannel:(NSString *)channel {
    NSString *appVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    HotUpdaterPrefs *prefs = [HotUpdaterPrefs sharedInstanceWithAppVersion:appVersion];
    [prefs setItem:channel forKey:@"HotUpdaterChannel"];
}

- (void)setBundleURL:(NSString *)localPath {
    NSLog(@"Setting bundle URL: %@", localPath);
    HotUpdaterPrefs *prefs = [self getPrefs];
    [prefs setItem:localPath forKey:@"HotUpdaterBundleURL"];
}

- (NSURL *)cachedURLFromBundle {
    HotUpdaterPrefs *prefs = [self getPrefs];
    NSString *savedURLString = [prefs getItemForKey:@"HotUpdaterBundleURL"];
    if (savedURLString) {
        NSURL *bundleURL = [NSURL URLWithString:savedURLString];
        if (bundleURL && [[NSFileManager defaultManager] fileExistsAtPath:[bundleURL path]]) {
            return bundleURL;
        }
    }
    return nil;
}

+ (NSURL *)fallbackURL {
    return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
}

+ (NSURL *)bundleURL {
    HotUpdater *instance = [[HotUpdater alloc] init];
    NSURL *url = [instance cachedURLFromBundle];
    return url ? url : [self fallbackURL];
}

#pragma mark - Utility Methods

- (BOOL)extractZipFileAtPath:(NSString *)filePath toDestination:(NSString *)destinationPath {
    NSError *error = nil;
    BOOL success = [SSZipArchive unzipFileAtPath:filePath toDestination:destinationPath overwrite:YES password:nil error:&error];
    if (!success) {
        NSLog(@"Failed to unzip file: %@", error);
    }
    return success;
}

#pragma mark - Cleanup Old Bundles

- (void)cleanupOldBundlesAtDirectory:(NSString *)bundleStoreDir {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSError *error = nil;
    NSArray *contents = [fileManager contentsOfDirectoryAtPath:bundleStoreDir error:&error];
    if (error) {
        NSLog(@"Failed to list bundle store directory: %@", error);
        return;
    }

    NSMutableArray *bundleDirs = [NSMutableArray array];
    for (NSString *item in contents) {
        NSString *fullPath = [bundleStoreDir stringByAppendingPathComponent:item];
        BOOL isDir = NO;
        if ([fileManager fileExistsAtPath:fullPath isDirectory:&isDir] && isDir) {
            [bundleDirs addObject:fullPath];
        }
    }

    // Sort in descending order by modification time (keep latest 1)
    [bundleDirs sortUsingComparator:^NSComparisonResult(NSString *path1, NSString *path2) {
        NSDictionary *attr1 = [fileManager attributesOfItemAtPath:path1 error:nil];
        NSDictionary *attr2 = [fileManager attributesOfItemAtPath:path2 error:nil];
        NSDate *date1 = attr1[NSFileModificationDate] ?: [NSDate dateWithTimeIntervalSince1970:0];
        NSDate *date2 = attr2[NSFileModificationDate] ?: [NSDate dateWithTimeIntervalSince1970:0];
        return [date2 compare:date1];
    }];

    if (bundleDirs.count > 1) {
        NSArray *oldBundles = [bundleDirs subarrayWithRange:NSMakeRange(1, bundleDirs.count - 1)];
        for (NSString *oldBundle in oldBundles) {
            NSError *delError = nil;
            if ([fileManager removeItemAtPath:oldBundle error:&delError]) {
                NSLog(@"Removed old bundle: %@", oldBundle);
            } else {
                NSLog(@"Failed to remove old bundle %@: %@", oldBundle, delError);
            }
        }
    }
}

#pragma mark - Update Bundle Method

- (void)updateBundle:(NSString *)bundleId zipUrl:(NSURL *)zipUrl maxRetries:(NSNumber *)maxRetries completion:(void (^)(BOOL success))completion {
    if (maxRetries != nil && executionCount > [maxRetries integerValue]) {
        @throw [NSException exceptionWithName:@"MaxRetriesExceededException"
                reason:[NSString stringWithFormat:@"Retry limit of %@ exceeded for bundle %@", maxRetries, bundleId]
                userInfo:nil];
    }
    [HotUpdater incrementExecutionCount];
    if (!zipUrl) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self setBundleURL:nil];
            if (completion) completion(YES);
        });
        return;
    }

    NSString *documentsPath = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
    NSString *bundleStoreDir = [documentsPath stringByAppendingPathComponent:@"bundle-store"];

    NSFileManager *fileManager = [NSFileManager defaultManager];
    if (![fileManager fileExistsAtPath:bundleStoreDir]) {
        [fileManager createDirectoryAtPath:bundleStoreDir withIntermediateDirectories:YES attributes:nil error:nil];
    }

    NSString *finalBundleDir = [bundleStoreDir stringByAppendingPathComponent:bundleId];

    if ([fileManager fileExistsAtPath:finalBundleDir]) {
        NSDirectoryEnumerator *enumerator = [fileManager enumeratorAtPath:finalBundleDir];
        NSString *foundBundle = nil;
        for (NSString *file in enumerator) {
            if ([file isEqualToString:@"index.ios.bundle"]) {
                foundBundle = file;
                break;
            }
        }
        if (foundBundle) {
            NSDictionary *attributes = @{NSFileModificationDate: [NSDate date]};
            [fileManager setAttributes:attributes ofItemAtPath:finalBundleDir error:nil];
            NSString *bundlePath = [finalBundleDir stringByAppendingPathComponent:foundBundle];
            NSLog(@"Using cached bundle at path: %@", bundlePath);
            [self setBundleURL:bundlePath];
            [self cleanupOldBundlesAtDirectory:bundleStoreDir];
            dispatch_async(dispatch_get_main_queue(), ^{
                if (completion) completion(YES);
            });
            return;
        } else {
            [fileManager removeItemAtPath:finalBundleDir error:nil];
        }
    }

    // Set up temporary folder (for download and extraction)
    NSString *tempDir = [documentsPath stringByAppendingPathComponent:@"bundle-temp"];
    if ([fileManager fileExistsAtPath:tempDir]) {
        [fileManager removeItemAtPath:tempDir error:nil];
    }
    [fileManager createDirectoryAtPath:tempDir withIntermediateDirectories:YES attributes:nil error:nil];

    NSString *tempZipFile = [tempDir stringByAppendingPathComponent:@"bundle.zip"];
    NSString *extractedDir = [tempDir stringByAppendingPathComponent:@"extracted"];
    [fileManager createDirectoryAtPath:extractedDir withIntermediateDirectories:YES attributes:nil error:nil];

    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];

    NSURLSessionDownloadTask *downloadTask = [session downloadTaskWithURL:zipUrl completionHandler:^(NSURL *location, NSURLResponse *response, NSError *error) {
        if (error) {
            NSLog(@"Failed to download data from URL: %@, error: %@", zipUrl, error);
            if (completion) completion(NO);
            return;
        }

        // Save temporary zip file
        if ([fileManager fileExistsAtPath:tempZipFile]) {
            [fileManager removeItemAtPath:tempZipFile error:nil];
        }

        NSError *moveError = nil;
        if (![fileManager moveItemAtURL:location toURL:[NSURL fileURLWithPath:tempZipFile] error:&moveError]) {
            NSLog(@"Failed to save downloaded file: %@", moveError);
            if (completion) completion(NO);
            return;
        }

        // Extract zip
        if (![self extractZipFileAtPath:tempZipFile toDestination:extractedDir]) {
            NSLog(@"Failed to extract zip file.");
            if (completion) completion(NO);
            return;
        }

        // Search for index.ios.bundle in extracted folder
        NSDirectoryEnumerator *enumerator = [fileManager enumeratorAtPath:extractedDir];
        NSString *foundBundle = nil;
        for (NSString *file in enumerator) {
            if ([file isEqualToString:@"index.ios.bundle"]) {
                foundBundle = file;
                break;
            }
        }

        if (!foundBundle) {
            NSLog(@"index.ios.bundle not found in extracted files.");
            if (completion) completion(NO);
            return;
        }

        // Move extracted folder to final bundle folder
        if ([fileManager fileExistsAtPath:finalBundleDir]) {
            [fileManager removeItemAtPath:finalBundleDir error:nil];
        }
        NSError *moveFinalError = nil;
        BOOL moved = [fileManager moveItemAtPath:extractedDir toPath:finalBundleDir error:&moveFinalError];
        if (!moved) {
            // Try copy and delete if move fails
            BOOL copied = [fileManager copyItemAtPath:extractedDir toPath:finalBundleDir error:&moveFinalError];
            if (copied) {
                [fileManager removeItemAtPath:extractedDir error:nil];
            } else {
                NSLog(@"Failed to move or copy extracted bundle: %@", moveFinalError);
                if (completion) completion(NO);
                return;
            }
        }

        // Recheck index.ios.bundle in final folder
        NSDirectoryEnumerator *finalEnum = [fileManager enumeratorAtPath:finalBundleDir];
        NSString *finalFoundBundle = nil;
        for (NSString *file in finalEnum) {
            if ([file isEqualToString:@"index.ios.bundle"]) {
                finalFoundBundle = file;
                break;
            }
        }

        if (!finalFoundBundle) {
            NSLog(@"index.ios.bundle not found in final directory.");
            if (completion) completion(NO);
            return;
        }

        // Update modification time of final bundle
        NSDictionary *attributes = @{NSFileModificationDate: [NSDate date]};
        [fileManager setAttributes:attributes ofItemAtPath:finalBundleDir error:nil];

        NSString *bundlePath = [finalBundleDir stringByAppendingPathComponent:finalFoundBundle];
        NSLog(@"Setting bundle URL: %@", bundlePath);
        dispatch_async(dispatch_get_main_queue(), ^{
            [self setBundleURL:bundlePath];
            [self cleanupOldBundlesAtDirectory:bundleStoreDir];
            [fileManager removeItemAtPath:tempDir error:nil];
            if (completion) completion(YES);
        });
    }];

    // Register KVO for progress updates
    [downloadTask addObserver:self forKeyPath:@"countOfBytesReceived" options:NSKeyValueObservingOptionNew context:nil];
    [downloadTask addObserver:self forKeyPath:@"countOfBytesExpectedToReceive" options:NSKeyValueObservingOptionNew context:nil];

    __weak HotUpdater *weakSelf = self;
    [[NSNotificationCenter defaultCenter] addObserverForName:@"NSURLSessionDownloadTaskDidFinishDownloading"
                                                      object:downloadTask
                                                       queue:[NSOperationQueue mainQueue]
                                                  usingBlock:^(NSNotification * _Nonnull note) {
        [weakSelf removeObserversForTask:downloadTask];
    }];

    [downloadTask resume];
}

#pragma mark - Folder Deletion Utility

- (void)deleteFolderIfExists:(NSString *)path {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    if ([fileManager fileExistsAtPath:path]) {
        NSError *error;
        [fileManager removeItemAtPath:path error:&error];
        if (error) {
            NSLog(@"Failed to delete existing folder: %@", error);
        } else {
            NSLog(@"Successfully deleted existing folder: %@", path);
        }
    }
}

#pragma mark - Progress Updates

- (void)removeObserversForTask:(NSURLSessionDownloadTask *)task {
    @try {
        if ([task observationInfo]) {
            [task removeObserver:self forKeyPath:@"countOfBytesReceived"];
            [task removeObserver:self forKeyPath:@"countOfBytesExpectedToReceive"];
            NSLog(@"KVO observers removed successfully for task: %@", task);
        }
    } @catch (NSException *exception) {
        NSLog(@"Failed to remove observers: %@", exception);
    }
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
    if ([keyPath isEqualToString:@"countOfBytesReceived"] || [keyPath isEqualToString:@"countOfBytesExpectedToReceive"]) {
        NSURLSessionDownloadTask *task = (NSURLSessionDownloadTask *)object;
        if (task.countOfBytesExpectedToReceive > 0) {
            double progress = (double)task.countOfBytesReceived / (double)task.countOfBytesExpectedToReceive;
            NSTimeInterval currentTime = [[NSDate date] timeIntervalSince1970] * 1000; // In milliseconds
            if ((currentTime - self.lastUpdateTime) >= 100 || progress >= 1.0) {
                self.lastUpdateTime = currentTime;
                [self sendEventWithName:@"onProgress" body:@{@"progress": @(progress)}];
            }
        }
    }
}

#pragma mark - React Native Events

- (NSArray<NSString *> *)supportedEvents {
    return @[@"onProgress"];
}

- (void)startObserving {
    hasListeners = YES;
}

- (void)stopObserving {
    hasListeners = NO;
}

- (void)sendEventWithName:(NSString * _Nonnull)name result:(NSDictionary *)result {
    [self sendEventWithName:name body:result];
}

#pragma mark - React Native Exports

RCT_EXPORT_METHOD(setChannel:(NSString *)channel
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [HotUpdater setChannel:channel];
    resolve(nil);
}

RCT_EXPORT_METHOD(reload) {
    NSLog(@"HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        NSURL *bundleURL = [HotUpdater bundleURL];
        if (bundleURL) {
            [super.bridge setValue:bundleURL forKey:@"bundleURL"];
        }
        RCTTriggerReloadCommandListeners(@"HotUpdater requested a reload");
    });
}

RCT_EXPORT_METHOD(getAppVersion:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
    NSString *version = [self getAppVersion];
    resolve(version ?: [NSNull null]);
}

RCT_EXPORT_METHOD(updateBundle:(NSDictionary *)bundleData resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
    NSString *bundleId = bundleData[@"bundleId"];
    NSString *zipUrlString = bundleData[@"zipUrl"];
    NSNumber *maxRetries = bundleData[@"maxRetries"];
    NSURL *zipUrl = nil;
    if (![zipUrlString isEqualToString:@""]) {
        zipUrl = [NSURL URLWithString:zipUrlString];
    }
    @try {
        [self updateBundle:bundleId zipUrl:zipUrl maxRetries:maxRetries completion:^(BOOL success) {
            dispatch_async(dispatch_get_main_queue(), ^{
                resolve(@[@(success)]);
            });
        }];
    }
    @catch (NSException *exception) {
        dispatch_async(dispatch_get_main_queue(), ^{
            reject(@"UPDATE_ERROR", exception.reason, nil);
        });
    }
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
    return std::make_shared<facebook::react::NativeHotUpdaterSpecJSI>(params);
}
#endif

@end
