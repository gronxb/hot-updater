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


+ (void)updateBundle:(NSString *)bundleId
              zipUrl:(NSURL *)zipUrl
     progressHandler:(void (^)(double progress))progressHandler
    completionHandler:(void (^)(BOOL success))completionHandler {
    if (!zipUrl) {
        [self setBundleURL:nil];
        completionHandler(YES);
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
            completionHandler(NO);
            return;
        }

        NSFileManager *fileManager = [NSFileManager defaultManager];
        NSError *folderError;
        if (![fileManager createDirectoryAtPath:[path stringByDeletingLastPathComponent]
                    withIntermediateDirectories:YES
                                     attributes:nil
                                          error:&folderError]) {
            NSLog(@"Failed to create folder: %@", folderError);
            completionHandler(NO);
            return;
        }

        NSError *moveError;
        if (![fileManager moveItemAtURL:location toURL:[NSURL fileURLWithPath:path] error:&moveError]) {
            NSLog(@"Failed to save data: %@", moveError);
            completionHandler(NO);
            return;
        }

        NSString *extractedPath = [path stringByDeletingLastPathComponent];
        if (![self extractZipFileAtPath:path toDestination:extractedPath]) {
            NSLog(@"Failed to extract zip file.");
            completionHandler(NO);
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
            [self setBundleURL:bundlePath];
        } else {
            NSLog(@"index.ios.bundle not found.");
            completionHandler(NO);
            return;
        }

        NSLog(@"Downloaded and extracted file successfully.");
        completionHandler(YES);
    }];

    if (progressHandler) {
        NSObject *observer = [[NSObject alloc] init];
        [downloadTask addObserver:observer
                       forKeyPath:@"countOfBytesReceived"
                          options:NSKeyValueObservingOptionNew
                          context:nil];
        
        [downloadTask addObserver:observer
                       forKeyPath:@"countOfBytesExpectedToReceive"
                          options:NSKeyValueObservingOptionNew
                          context:nil];
    }

    [downloadTask resume];
}

#pragma mark - React Native Exports

RCT_EXPORT_METHOD(reload) {
    [HotUpdater reload];
}

RCT_EXPORT_METHOD(getAppVersion:resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
    NSString *version = [HotUpdater getAppVersion];
    resolve(@[version ?: [NSNull null]]);
}

RCT_EXPORT_METHOD(updateBundle:(NSString *)bundleId zipUrl:(NSString *)zipUrlString resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
    NSURL *zipUrl = nil;
    if (![zipUrlString isEqualToString:@""]) {
        zipUrl = [NSURL URLWithString:zipUrlString];
    }

    [HotUpdater updateBundle:bundleId zipUrl:zipUrl progressHandler:^(double progress) {
        NSLog(@"Progress: %f", progress);
    } completionHandler:^(BOOL success) {
        resolve(@[@(success)]);
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
