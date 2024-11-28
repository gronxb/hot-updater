#import "HotUpdater.h"

#import <SSZipArchive/SSZipArchive.h>

@implementation HotUpdater

RCT_EXPORT_MODULE();

#pragma mark - Bundle URL Management

+ (void)reload {
    NSLog(@"HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        RCTTriggerReloadCommandListeners(@"HotUpdater requested a reload");
    });
}

+ (NSString *)getAppVersion {
    NSString *appVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    return appVersion;
}

+ (void)setBundleURL:(NSString *)localPath {
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

+ (NSString *)convertFileSystemPathFromBasePath:(NSString *)basePath {
    return [[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject] stringByAppendingPathComponent:basePath];
}

+ (NSString *)stripPrefixFromPath:(NSString *)prefix path:(NSString *)path {
    if ([path hasPrefix:[NSString stringWithFormat:@"/%@/", prefix]]) {
        return [path stringByReplacingOccurrencesOfString:[NSString stringWithFormat:@"/%@/", prefix] withString:@""];
    }
    return path;
}

+ (BOOL)extractZipFileAtPath:(NSString *)filePath toDestination:(NSString *)destinationPath {
    NSError *error = nil;
    BOOL success = [SSZipArchive unzipFileAtPath:filePath toDestination:destinationPath overwrite:YES password:nil error:&error];
    if (!success) {
        NSLog(@"Failed to unzip file: %@", error);
    }
    return success;
}


+ (BOOL)updateBundle:(NSString *)bundleId zipUrl:(NSURL *)zipUrl {
    if (!zipUrl) {
        [self setBundleURL:nil];
        return YES;
    }
    
    NSLog(@"Updating bundle: %@ %@", bundleId, zipUrl);
    NSString *basePath = [self stripPrefixFromPath:bundleId path:[zipUrl path]];
    NSString *path = [self convertFileSystemPathFromBasePath:basePath];
    
    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
    
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block BOOL success = NO;
    
    NSURLSessionDownloadTask *downloadTask = [session downloadTaskWithURL:zipUrl
                                                        completionHandler:^(NSURL *location, NSURLResponse *response, NSError *error) {
        if (error) {
            NSLog(@"Failed to download data from URL: %@, error: %@", zipUrl, error);
            success = NO;
            dispatch_semaphore_signal(semaphore);
            return;
        }
        
        // Process the downloaded file (e.g., unzip and validate)
        // Update progress using sendEventWithName
        double progress = 1.0; // Example progress value
        
        NSLog(@"Sending progress event: %@", @(progress));
        [[self alloc] sendEventWithName:@"onProgress" body:@{@"progress": @(progress)}];
        
        success = YES;
        dispatch_semaphore_signal(semaphore);
    }];
    
    [downloadTask resume];
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    
    return success;
}

#pragma mark - React Native Events
- (NSArray<NSString *> *)supportedEvents {
    return @[@"onProgress"];
}

#pragma mark - React Native Exports

RCT_EXPORT_METHOD(reload) {
    [HotUpdater reload];
}

RCT_EXPORT_METHOD(getAppVersion:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject) {
    NSString *version = [HotUpdater getAppVersion];
    resolve(version ?: [NSNull null]);
}

RCT_EXPORT_METHOD(updateBundle:(NSString *)bundleId zipUrl:(NSString *)zipUrlString resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
    NSURL *zipUrl = nil;
    if (![zipUrlString isEqualToString:@""]) {
        zipUrl = [NSURL URLWithString:zipUrlString];
    }
    
    BOOL result = [HotUpdater updateBundle:bundleId zipUrl:zipUrl];
    resolve(@[@(result)]);
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
