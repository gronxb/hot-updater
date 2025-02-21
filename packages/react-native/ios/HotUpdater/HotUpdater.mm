#import "HotUpdater.h"
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
    // This supports React Native 0.72.6
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

- (BOOL)extractZipFileAtPath:(NSString *)filePath toDestination:(NSString *)destinationPath {
    NSError *error = nil;
    BOOL success = [SSZipArchive unzipFileAtPath:filePath toDestination:destinationPath overwrite:YES password:nil error:&error];
    if (!success) {
        NSLog(@"Failed to unzip file: %@", error);
    }
    return success;
}

#pragma mark - Update Bundle Method

- (void)updateBundle:(NSString *)bundleId zipUrl:(NSURL *)zipUrl completion:(void (^)(BOOL success))completion {
    if (!zipUrl) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self setBundleURL:nil];
            if (completion) completion(YES);
        });
        return;
    }
    
    // Get documents directory path
    NSString *documentsPath = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
    // Directory for storing final bundle (bundle-store)
    NSString *finalDir = [documentsPath stringByAppendingPathComponent:@"bundle-store"];
    // Temporary directory (bundle-temp)
    NSString *tempDir = [documentsPath stringByAppendingPathComponent:@"bundle-temp"];
    // Directory for extracting zip file (extracted)
    NSString *extractedDir = [tempDir stringByAppendingPathComponent:@"extracted"];
    // Path for temporarily storing zip file
    NSString *zipFilePath = [tempDir stringByAppendingPathComponent:@"build.zip"];
    
    // Initialize temporary directory
    [self deleteFolderIfExists:tempDir];
    [[NSFileManager defaultManager] createDirectoryAtPath:tempDir withIntermediateDirectories:YES attributes:nil error:nil];
    [[NSFileManager defaultManager] createDirectoryAtPath:extractedDir withIntermediateDirectories:YES attributes:nil error:nil];
    
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
        
        // 기존 zip 파일이 있으면 삭제
        if ([fileManager fileExistsAtPath:zipFilePath]) {
            [fileManager removeItemAtPath:zipFilePath error:nil];
        }
        
        // Move downloaded file to temporary zipFilePath
        NSError *moveError;
        if (![fileManager moveItemAtURL:location toURL:[NSURL fileURLWithPath:zipFilePath] error:&moveError]) {
            NSLog(@"Failed to save downloaded file: %@", moveError);
            if (completion) completion(NO);
            return;
        }
        
        // Extract temporary zip file to extractedDir
        if (![self extractZipFileAtPath:zipFilePath toDestination:extractedDir]) {
            NSLog(@"Failed to extract zip file.");
            if (completion) completion(NO);
            return;
        }
        
        // Search for bundle file (index.ios.bundle) in extractedDir
        NSDirectoryEnumerator *enumerator = [fileManager enumeratorAtPath:extractedDir];
        NSString *filename = nil;
        for (NSString *file in enumerator) {
            if ([file isEqualToString:@"index.ios.bundle"]) {
                filename = file;
                break;
            }
        }
        
        if (filename) {
            // Delete existing finalDir (bundle-store) before setBundleURL
            [self deleteFolderIfExists:finalDir];
            
            NSError *moveFinalError = nil;
            // Move entire extractedDir to finalDir (moveItemAtPath can be used within same parent directory)
            BOOL moved = [fileManager moveItemAtPath:extractedDir toPath:finalDir error:&moveFinalError];
            if (!moved) {
                NSLog(@"Failed to move extracted folder to final directory: %@. Attempting to copy...", moveFinalError);
                // Manual copy if move fails
                NSError *copyError = nil;
                BOOL copySuccess = [fileManager copyItemAtPath:extractedDir toPath:finalDir error:&copyError];
                if (!copySuccess) {
                    NSLog(@"Failed to copy extracted folder to final directory: %@", copyError);
                    if (completion) completion(NO);
                    return;
                }
                [self deleteFolderIfExists:extractedDir];
            }
            
            // Construct final bundle file path
            NSString *bundlePath = [finalDir stringByAppendingPathComponent:filename];
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
    
    // Add observer for progress updates via KVO
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

RCT_EXPORT_METHOD(reload) {
    NSLog(@"HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        [super.bridge setValue:[HotUpdater bundleURL] forKey:@"bundleURL"];
        RCTTriggerReloadCommandListeners(@"HotUpdater requested a reload");
    });
}

RCT_EXPORT_METHOD(getAppVersion:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
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

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
    return std::make_shared<facebook::react::NativeHotUpdaterSpecJSI>(params);
}
#endif

@end