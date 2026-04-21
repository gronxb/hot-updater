#import "BsdiffPatchBridge.h"

#include <bzlib.h>

namespace {
constexpr NSUInteger kBzipChunkSize = 64 * 1024;

NSError *MakePatchError(NSString *message) {
  return [NSError errorWithDomain:@"HotUpdater.Bsdiff"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

int64_t ReadOfft(const uint8_t *bytes) {
  uint64_t value = 0;
  for (NSUInteger index = 0; index < 8; index += 1) {
    value |= (static_cast<uint64_t>(bytes[index]) << (index * 8));
  }

  if ((value & (1ULL << 63)) == 0) {
    return static_cast<int64_t>(value);
  }

  return -static_cast<int64_t>(value & ~(1ULL << 63));
}

NSData *DecompressBzip(NSData *compressed, NSError **error) {
  bz_stream stream = {};
  stream.next_in = reinterpret_cast<char *>(const_cast<void *>(compressed.bytes));
  stream.avail_in = static_cast<unsigned int>(compressed.length);

  int status = BZ2_bzDecompressInit(&stream, 0, 0);
  if (status != BZ_OK) {
    if (error) {
      *error = MakePatchError(@"Failed to initialize bzip stream");
    }
    return nil;
  }

  NSMutableData *output = [NSMutableData data];

  do {
    NSUInteger start = output.length;
    [output increaseLengthBy:kBzipChunkSize];

    stream.next_out =
        reinterpret_cast<char *>(output.mutableBytes) + start;
    stream.avail_out = static_cast<unsigned int>(kBzipChunkSize);

    status = BZ2_bzDecompress(&stream);
    if (status != BZ_OK && status != BZ_STREAM_END) {
      BZ2_bzDecompressEnd(&stream);
      if (error) {
        *error = MakePatchError(@"Failed to decompress bzip block");
      }
      return nil;
    }

    output.length = start + (kBzipChunkSize - stream.avail_out);
  } while (status != BZ_STREAM_END);

  BZ2_bzDecompressEnd(&stream);
  return output;
}
}  // namespace

extern "C" BOOL HotUpdaterApplyBsdiffPatch(NSString *patchPath,
                                            NSString *basePath,
                                            NSString *outputPath) {
  NSError *patchError = nil;
  BOOL applied = [BsdiffPatchBridge applyPatchAtPath:patchPath
                                         toBaseAtPath:basePath
                                        outputAtPath:outputPath
                                               error:&patchError];
  if (!applied && patchError != nil) {
    NSLog(@"[BundleStorage] Failed to apply bsdiff patch: %@",
          patchError.localizedDescription);
  }
  return applied;
}

@implementation BsdiffPatchBridge

+ (BOOL)applyPatchAtPath:(NSString *)patchPath
             toBaseAtPath:(NSString *)basePath
            outputAtPath:(NSString *)outputPath
                   error:(NSError * _Nullable __autoreleasing *)error {
  NSData *baseData = [NSData dataWithContentsOfFile:basePath options:0 error:error];
  if (!baseData) {
    return NO;
  }

  NSData *patchData = [NSData dataWithContentsOfFile:patchPath options:0 error:error];
  if (!patchData) {
    return NO;
  }

  if (patchData.length < 24 ||
      memcmp(patchData.bytes, "ENDSLEY/BSDIFF43", 16) != 0) {
    if (error) {
      *error = MakePatchError(@"Invalid ENDSLEY/BSDIFF43 header");
    }
    return NO;
  }

  const uint8_t *patchBytes = reinterpret_cast<const uint8_t *>(patchData.bytes);
  int64_t newSize = ReadOfft(patchBytes + 16);

  if (newSize < 0) {
    if (error) {
      *error = MakePatchError(@"Negative ENDSLEY/BSDIFF43 target size");
    }
    return NO;
  }

  if (static_cast<uint64_t>(newSize) > NSUIntegerMax) {
    if (error) {
      *error = MakePatchError(@"Target file is too large");
    }
    return NO;
  }

  NSData *compressedPatch =
      [patchData subdataWithRange:NSMakeRange(24, patchData.length - 24)];
  NSData *patchStreamData = DecompressBzip(compressedPatch, error);
  if (!patchStreamData) {
    return NO;
  }

  NSMutableData *output =
      [NSMutableData dataWithLength:static_cast<NSUInteger>(newSize)];
  uint8_t *outputBytes = reinterpret_cast<uint8_t *>(output.mutableBytes);
  const uint8_t *baseBytes = reinterpret_cast<const uint8_t *>(baseData.bytes);
  const uint8_t *streamBytes =
      reinterpret_cast<const uint8_t *>(patchStreamData.bytes);

  NSUInteger streamPos = 0;
  NSUInteger outputPos = 0;
  int64_t oldPos = 0;

  while (outputPos < static_cast<NSUInteger>(newSize)) {
    if (streamPos + 24 > patchStreamData.length) {
      if (error) {
        *error = MakePatchError(@"Failed to read control block");
      }
      return NO;
    }

    int64_t addLen = ReadOfft(streamBytes + streamPos);
    int64_t copyLen = ReadOfft(streamBytes + streamPos + 8);
    int64_t seekLen = ReadOfft(streamBytes + streamPos + 16);
    streamPos += 24;

    if (addLen < 0 || copyLen < 0) {
      if (error) {
        *error = MakePatchError(@"Negative add/copy length in control block");
      }
      return NO;
    }

    NSUInteger addCount = static_cast<NSUInteger>(addLen);
    NSUInteger copyCount = static_cast<NSUInteger>(copyLen);
    int64_t remainingOutput =
        newSize - static_cast<int64_t>(outputPos);

    if (addLen > remainingOutput || copyLen > remainingOutput - addLen ||
        addCount > patchStreamData.length - streamPos ||
        copyCount > patchStreamData.length - streamPos - addCount) {
      if (error) {
        *error = MakePatchError(@"ENDSLEY/BSDIFF43 stream is truncated");
      }
      return NO;
    }

    for (NSUInteger index = 0; index < addCount; index += 1) {
      uint8_t oldByte =
          (oldPos >= 0 && oldPos < static_cast<int64_t>(baseData.length))
              ? baseBytes[oldPos]
              : 0;
      uint8_t deltaByte = streamBytes[streamPos + index];
      outputBytes[outputPos] =
          static_cast<uint8_t>((deltaByte + oldByte) & 0xFF);
      outputPos += 1;
      oldPos += 1;
    }
    streamPos += addCount;

    if (copyCount > 0) {
      memcpy(outputBytes + outputPos, streamBytes + streamPos, copyCount);
      outputPos += copyCount;
      streamPos += copyCount;
    }

    oldPos += seekLen;
  }

  if (![output writeToFile:outputPath options:NSDataWritingAtomic error:error]) {
    return NO;
  }

  return YES;
}

@end
