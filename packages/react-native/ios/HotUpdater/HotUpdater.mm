#import "HotUpdater.h"
#import <React/RCTReloadCommand.h>
#import <SSZipArchive/SSZipArchive.h>
#import <Foundation/NSURLSession.h>

@implementation HotUpdater {
    bool hasListeners;
}


- (instancetype)init {
    self = [super init];
    if (self) {
        _lastUpdateTime = 0;
    }
    return self;
}

RCT_EXPORT_MODULE();

#pragma mark - Bundle URL Management


- (NSString *)getAppVersion {
    NSString *appVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    return appVersion;
}

- (void)setBundleURL:(NSString *)localPath {
    NSLog(@"Setting bundle URL: %@", localPath);
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setObject:localPath forKey:@"HotUpdaterBundleURL"];
    [defaults synchronize];
}

+ (NSURL *)cachedURLFromBundle {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *savedURLString = [defaults objectForKey:@"HotUpdaterBundleURL"];
    
    if (savedURLString) {
        NSURL *bundleURL = [NSURL URLWithString:savedURLString];
        if (bundleURL && [[NSFileManager defaultManager] fileExistsAtPath:[bundleURL path]]) {
            return bundleURL;
        }
    }
    return nil;
}

+ (NSURL *)fallbackURL {
    // This Support React Native 0.72.6
#if DEBUG
    return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
    return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

+ (NSURL *)bundleURL {
    return [self cachedURLFromBundle] ?: [self fallbackURL];
}

#pragma mark - Utility Methods

- (NSString *)convertFileSystemPathFromBasePath:(NSString *)basePath {
    return [[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject] stringByAppendingPathComponent:basePath];
}

- (NSString *)stripPrefixFromPath:(NSString *)prefix path:(NSString *)path {
    if ([path hasPrefix:[NSString stringWithFormat:@"/%@/", prefix]]) {
        return [path stringByReplacingOccurrencesOfString:[NSString stringWithFormat:@"/%@/", prefix] withString:@""];
    }
    return path;
}

- (BOOL)extractZipFileAtPath:(NSString *)filePath toDestination:(NSString *)destinationPath {
    NSError *error = nil;
    BOOL success = [SSZipArchive unzipFileAtPath:filePath toDestination:destinationPath overwrite:YES password:nil error:&error];
    if (!success) {
        NSLog(@"Failed to unzip file: %@", error);
    }
    return success;
}

- (void)updateBundle:(NSString *)bundleId zipUrl:(NSURL *)zipUrl completion:(void (^)(BOOL success))completion {
    if (!zipUrl) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self setBundleURL:nil];
            if (completion) completion(YES);
        });
        return;
    }

    NSString *basePath = [self stripPrefixFromPath:bundleId path:[zipUrl path]];
    NSString *path = [self convertFileSystemPathFromBasePath:basePath];

    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];

    NSURLSessionDownloadTask *downloadTask = [session downloadTaskWithURL:zipUrl
                                                        completionHandler:^(NSURL *location, NSURLResponse *response, NSError *error) {
        if (error) {
            NSLog(@"Failed to download data from URL: %@, error: %@", zipUrl, error);
            if (completion) completion(NO);
            return;
        }

        NSFileManager *fileManager = [NSFileManager defaultManager];
        NSError *folderError;

        // Ensure directory exists
        if (![fileManager createDirectoryAtPath:[path stringByDeletingLastPathComponent]
                    withIntermediateDirectories:YES
                                     attributes:nil
                                          error:&folderError]) {
            NSLog(@"Failed to create folder: %@", folderError);
            if (completion) completion(NO);
            return;
        }

        // Check if file already exists and remove it
        if ([fileManager fileExistsAtPath:path]) {
            NSError *removeError;
            if (![fileManager removeItemAtPath:path error:&removeError]) {
                NSLog(@"Failed to remove existing file: %@", removeError);
                if (completion) completion(NO);
                return;
            }
        }

        NSError *moveError;
        if (![fileManager moveItemAtURL:location toURL:[NSURL fileURLWithPath:path] error:&moveError]) {
            NSLog(@"Failed to save data: %@", moveError);
            if (completion) completion(NO);
            return;
        }

        NSString *extractedPath = [path stringByDeletingLastPathComponent];
        if (![self extractZipFileAtPath:path toDestination:extractedPath]) {
            NSLog(@"Failed to extract zip file.");
            if (completion) completion(NO);
            return;
        }

        NSDirectoryEnumerator *enumerator = [fileManager enumeratorAtPath:extractedPath];
        NSString *filename = nil;
        for (NSString *file in enumerator) {
            if ([file isEqualToString:@"index.ios.bundle"]) {
                filename = file;
                break;
            }
        }

        if (filename) {
            NSString *bundlePath = [extractedPath stringByAppendingPathComponent:filename];
            NSLog(@"Setting bundle URL: %@", bundlePath);
            dispatch_async(dispatch_get_main_queue(), ^{
                [self setBundleURL:bundlePath];
                if (completion) completion(YES);
            });
        } else {
            NSLog(@"index.ios.bundle not found.");
            if (completion) completion(NO);
        }
    }];

    
    // Add observer for progress updates
    [downloadTask addObserver:self
                forKeyPath:@"countOfBytesReceived"
                    options:NSKeyValueObservingOptionNew
                    context:nil];
    [downloadTask addObserver:self
                forKeyPath:@"countOfBytesExpectedToReceive"
                    options:NSKeyValueObservingOptionNew
                    context:nil];

    __block HotUpdater *weakSelf = self;
    [[NSNotificationCenter defaultCenter] addObserverForName:@"NSURLSessionDownloadTaskDidFinishDownloading"
        object:downloadTask
        queue:[NSOperationQueue mainQueue]
    usingBlock:^(NSNotification * _Nonnull note) {
        [weakSelf removeObserversForTask:downloadTask];
    }];
    [downloadTask resume];

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
            
            // Get current timestamp
            NSTimeInterval currentTime = [[NSDate date] timeIntervalSince1970] * 1000; // Convert to milliseconds
            
            // Send event only if 200ms has passed OR progress is 100%
            if ((currentTime - self.lastUpdateTime) >= 200 || progress >= 1.0) {
                self.lastUpdateTime = currentTime; // Update last event timestamp

                // Send progress to React Native
                [self sendEventWithName:@"onProgress" body:@{@"progress": @(progress)}];
            }
        }
    }
}


#pragma mark - React Native Events
- (NSArray<NSString *> *)supportedEvents {
    return @[@"onProgress"];
}

- (void)startObserving
{
    hasListeners = YES;
}

- (void)stopObserving
{
    hasListeners = NO;
}


- (void)sendEventWithName:(NSString * _Nonnull)name result:(NSDictionary *)result {
    [self sendEventWithName:name body:result];
}


#pragma mark - React Native Exports

RCT_EXPORT_METHOD(reload) {
    NSLog(@"HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        RCTTriggerReloadCommandListeners(@"HotUpdater requested a reload");
    });
}

RCT_EXPORT_METHOD(getAppVersion:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    NSString *version = [self getAppVersion];
    resolve(version ?: [NSNull null]);
}

RCT_EXPORT_METHOD(updateBundle:(NSString *)bundleId zipUrl:(NSString *)zipUrlString resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
    NSURL *zipUrl = nil;
    if (![zipUrlString isEqualToString:@""]) {
        zipUrl = [NSURL URLWithString:zipUrlString];
    }

    [self updateBundle:bundleId zipUrl:zipUrl completion:^(BOOL success) {
        dispatch_async(dispatch_get_main_queue(), ^{
            resolve(@[@(success)]);
        });
    }];
}


// Don't compile this code when we build for the old architecture.
#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
(const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeHotUpdaterSpecJSI>(params);
}
#endif

@end
