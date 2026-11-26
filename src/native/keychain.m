#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <stdint.h>
#include <string.h>

__attribute__((visibility("default"))) int32_t mcp_keychain_get(
    const char *service,
    const char *account,
    uint8_t *buffer,
    int32_t capacity
) {
    if (service == NULL || account == NULL || buffer == NULL || capacity <= 0) return -1;
    @autoreleasepool {
        NSString *nsService = [NSString stringWithUTF8String:service];
        NSString *nsAccount = [NSString stringWithUTF8String:account];
        if (nsService == nil || nsAccount == nil) return -1;
        NSDictionary *query = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: nsService,
            (__bridge id)kSecAttrAccount: nsAccount,
            (__bridge id)kSecReturnData: @YES,
            (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
        };
        CFTypeRef result = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
        if (status != errSecSuccess || result == NULL) {
            if (result != NULL) CFRelease(result);
            return -1;
        }
        NSData *data = (__bridge_transfer NSData *)result;
        NSUInteger length = data.length;
        if (length > (NSUInteger)capacity) return -2;
        if (length > 0) memcpy(buffer, data.bytes, length);
        return (int32_t)length;
    }
}

__attribute__((visibility("default"))) int32_t mcp_keychain_set(
    const char *service,
    const char *account,
    const uint8_t *value,
    int32_t value_len
) {
    if (service == NULL || account == NULL || value == NULL || value_len <= 0) return -1;
    @autoreleasepool {
        NSString *nsService = [NSString stringWithUTF8String:service];
        NSString *nsAccount = [NSString stringWithUTF8String:account];
        if (nsService == nil || nsAccount == nil) return -1;
        NSData *data = [NSData dataWithBytes:value length:(NSUInteger)value_len];
        NSDictionary *query = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: nsService,
            (__bridge id)kSecAttrAccount: nsAccount,
        };
        NSDictionary *attributes = @{
            (__bridge id)kSecValueData: data,
        };
        OSStatus status = SecItemUpdate(
            (__bridge CFDictionaryRef)query,
            (__bridge CFDictionaryRef)attributes
        );
        if (status == errSecItemNotFound) {
            NSDictionary *addQuery = @{
                (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
                (__bridge id)kSecAttrService: nsService,
                (__bridge id)kSecAttrAccount: nsAccount,
                (__bridge id)kSecValueData: data,
                (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleWhenUnlocked,
            };
            status = SecItemAdd((__bridge CFDictionaryRef)addQuery, NULL);
        }
        return status == errSecSuccess ? 0 : -1;
    }
}

__attribute__((visibility("default"))) int32_t mcp_keychain_delete(
    const char *service,
    const char *account
) {
    if (service == NULL || account == NULL) return -1;
    @autoreleasepool {
        NSString *nsService = [NSString stringWithUTF8String:service];
        NSString *nsAccount = [NSString stringWithUTF8String:account];
        if (nsService == nil || nsAccount == nil) return -1;
        NSDictionary *query = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: nsService,
            (__bridge id)kSecAttrAccount: nsAccount,
        };
        OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
        return (status == errSecSuccess || status == errSecItemNotFound) ? 0 : -1;
    }
}
