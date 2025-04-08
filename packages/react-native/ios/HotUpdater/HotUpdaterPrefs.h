#import <Foundation/Foundation.h>

@interface HotUpdaterPrefs : NSObject

+ (instancetype)sharedInstanceWithAppVersion:(NSString *)appVersion;
- (NSString *)getItemForKey:(NSString *)key;
- (void)setItem:(NSString *)value forKey:(NSString *)key;

@end