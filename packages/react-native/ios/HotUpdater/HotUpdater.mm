#import "HotUpdater.h"
#import <libarchive/archive.h>
#import <libarchive/archive_entry.h>

@implementation HotUpdater

RCT_EXPORT_MODULE();

static NSURL *_bundleURL = nil;

#pragma mark - Bundle URL Management

+ (void)reload {
    NSLog(@"HotUpdater requested a reload");
    dispatch_async(dispatch_get_main_queue(), ^{
        RCTTriggerReloadCommandListeners(@"HotUpdater requested a reload");
    });
}

+ (void)setBundleVersion:(NSString*)bundleVersion {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults setObject:bundleVersion forKey:@"HotUpdaterBundleVersion"];
        [defaults synchronize];
    });
}

+ (NSString *)getAppVersion {
   NSString *appVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
   return appVersion;
}

+ (NSNumber *)getBundleVersion {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *bundleVersion = [defaults objectForKey:@"HotUpdaterBundleVersion"];
    
    if ([bundleVersion isKindOfClass:[NSString class]] && bundleVersion.length > 0) {
        NSNumber *version = @([bundleVersion integerValue]);
        return version;
    }
    
    return @(-1); // 기본값을 NSNumber로 반환
}

+ (void)setBundleURL:(NSString *)localPath {
    NSLog(@"Setting bundle URL: %@", localPath);
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        _bundleURL = [NSURL fileURLWithPath:localPath];
        [[NSUserDefaults standardUserDefaults] setObject:[_bundleURL absoluteString] forKey:@"HotUpdaterBundleURL"];
        [[NSUserDefaults standardUserDefaults] synchronize];
    });
}

+ (NSURL *)cachedURLFromBundle {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSString *savedURLString = [[NSUserDefaults standardUserDefaults] objectForKey:@"HotUpdaterBundleURL"];
        if (savedURLString) {
            _bundleURL = [NSURL URLWithString:savedURLString];
        }
    });

    if (_bundleURL && [[NSFileManager defaultManager] fileExistsAtPath:[_bundleURL path]]) {
        return _bundleURL;
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

+ (NSURL *)bundleURLWithoutFallback {
    return [self cachedURLFromBundle];
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


- (BOOL)extractTarGzFileAtPath:(NSString *)filePath toDestination:(NSString *)destinationPath {
    struct archive *a;
    struct archive *ext;
    struct archive_entry *entry;
    int r;

    a = archive_read_new();
    archive_read_support_format_tar(a);
    archive_read_support_filter_gzip(a);
    ext = archive_write_disk_new();
    archive_write_disk_set_options(ext, ARCHIVE_EXTRACT_TIME);
    archive_write_disk_set_standard_lookup(ext);

    if ((r = archive_read_open_filename(a, [filePath UTF8String], 10240))) {
        NSLog(@"archive_read_open_filename() failed: %s", archive_error_string(a));
        return NO;
    }

    while (archive_read_next_header(a, &entry) == ARCHIVE_OK) {
        NSString *currentFile = [NSString stringWithUTF8String:archive_entry_pathname(entry)];
        NSString *fullOutputPath = [destinationPath stringByAppendingPathComponent:currentFile];
        archive_entry_set_pathname(entry, [fullOutputPath UTF8String]);
        r = archive_write_header(ext, entry);
        if (r != ARCHIVE_OK) {
            NSLog(@"archive_write_header() failed: %s", archive_error_string(ext));
        } else {
            char buffer[8192];
            ssize_t size;
            while ((size = archive_read_data(a, buffer, sizeof(buffer))) > 0) {
                if (archive_write_data(ext, buffer, size) < size) {
                    NSLog(@"archive_write_data() failed: %s", archive_error_string(ext));
                    break;
                }
            }
            archive_write_finish_entry(ext);
        }
    }

    archive_read_close(a);
    archive_read_free(a);
    archive_write_close(ext);
    archive_write_free(ext);

    return YES;
}

+ (BOOL)updateBundle:(NSString *)prefix url:(NSURL *)url {
    NSString *filename = [url lastPathComponent];
    NSString *basePath = [self stripPrefixFromPath:prefix path:[url path]];
    NSString *path = [self convertFileSystemPathFromBasePath:basePath];

    NSData *data = [NSData dataWithContentsOfURL:url];
    if (!data) {
        NSLog(@"Failed to download data from URL: %@", url);
        return NO;
    }

    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSError *folderError;
    if (![fileManager createDirectoryAtPath:[path stringByDeletingLastPathComponent]
                withIntermediateDirectories:YES
                                 attributes:nil
                                      error:&folderError]) {
        NSLog(@"Failed to create folder: %@", folderError);
        return NO;
    }

    NSError *error;
    [data writeToFile:path options:NSDataWritingAtomic error:&error];
    if (error) {
        NSLog(@"Failed to save data: %@", error);
        return NO;
    }

    // 압축 해제 부분
    if (![self extractTarGzFileAtPath:path toDestination:[path stringByDeletingLastPathComponent]]) {
        NSLog(@"Failed to extract tar.gz file.");
        return NO;
    }

    // 성공적으로 다운로드 및 압축 해제한 경우 번들 설정
    if ([filename isEqualToString:@"index.ios.bundle.js"]) {
        NSLog(@"Setting bundle URL: %@", path);
        [self setBundleURL:path];
    }

    [self setBundleVersion:prefix];
    NSLog(@"Downloaded and extracted file successfully.");

    return YES;
}

#pragma mark - React Native Exports

RCT_EXPORT_METHOD(reload) {
    [HotUpdater reload];
}

RCT_EXPORT_METHOD(getBundleVersion:(RCTResponseSenderBlock)callback) {
    NSNumber *bundleVersion = [HotUpdater getBundleVersion];
    callback(@[bundleVersion]);
}


RCT_EXPORT_METHOD(getAppVersion:(RCTResponseSenderBlock)callback) {
    NSString *version = [HotUpdater getAppVersion];
    callback(@[version ?: [NSNull null]]);
}

RCT_EXPORT_METHOD(updateBundle:(NSString *)prefix urlString:(NSString *)urlString callback:(RCTResponseSenderBlock)callback) {
    NSURL *url = [NSURL URLWithString:urlString];
    if (!url) {
        callback(@[@(NO)]);
        return;
    }

    BOOL result = [HotUpdater updateBundle:prefix url:url];
    callback(@[@(result)]);
}
@end
