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

  if (patchData.length < 32 ||
      memcmp(patchData.bytes, "BSDIFF40", 8) != 0) {
    if (error) {
      *error = MakePatchError(@"Invalid BSDIFF40 header");
    }
    return NO;
  }

  const uint8_t *patchBytes = reinterpret_cast<const uint8_t *>(patchData.bytes);
  int64_t ctrlLen = ReadOfft(patchBytes + 8);
  int64_t diffLen = ReadOfft(patchBytes + 16);
  int64_t newSize = ReadOfft(patchBytes + 24);

  if (ctrlLen < 0 || diffLen < 0 || newSize < 0) {
    if (error) {
      *error = MakePatchError(@"Negative BSDIFF40 header values");
    }
    return NO;
  }

  NSUInteger ctrlStart = 32;
  NSUInteger ctrlEnd = ctrlStart + static_cast<NSUInteger>(ctrlLen);
  NSUInteger diffEnd = ctrlEnd + static_cast<NSUInteger>(diffLen);

  if (ctrlEnd < ctrlStart || diffEnd < ctrlEnd || diffEnd > patchData.length) {
    if (error) {
      *error = MakePatchError(@"BSDIFF40 block bounds are invalid");
    }
    return NO;
  }

  NSData *ctrlCompressed =
      [patchData subdataWithRange:NSMakeRange(ctrlStart, ctrlEnd - ctrlStart)];
  NSData *diffCompressed =
      [patchData subdataWithRange:NSMakeRange(ctrlEnd, diffEnd - ctrlEnd)];
  NSData *extraCompressed =
      [patchData subdataWithRange:NSMakeRange(diffEnd, patchData.length - diffEnd)];

  NSData *ctrlData = DecompressBzip(ctrlCompressed, error);
  NSData *diffData = DecompressBzip(diffCompressed, error);
  NSData *extraData = DecompressBzip(extraCompressed, error);
  if (!ctrlData || !diffData || !extraData) {
    return NO;
  }

  NSMutableData *output =
      [NSMutableData dataWithLength:static_cast<NSUInteger>(newSize)];
  uint8_t *outputBytes = reinterpret_cast<uint8_t *>(output.mutableBytes);
  const uint8_t *baseBytes = reinterpret_cast<const uint8_t *>(baseData.bytes);
  const uint8_t *ctrlBytes = reinterpret_cast<const uint8_t *>(ctrlData.bytes);
  const uint8_t *diffBytes = reinterpret_cast<const uint8_t *>(diffData.bytes);
  const uint8_t *extraBytes = reinterpret_cast<const uint8_t *>(extraData.bytes);

  NSUInteger ctrlPos = 0;
  NSUInteger diffPos = 0;
  NSUInteger extraPos = 0;
  NSUInteger outputPos = 0;
  int64_t oldPos = 0;

  while (outputPos < static_cast<NSUInteger>(newSize)) {
    if (ctrlPos + 24 > ctrlData.length) {
      if (error) {
        *error = MakePatchError(@"Failed to read control block");
      }
      return NO;
    }

    int64_t addLen = ReadOfft(ctrlBytes + ctrlPos);
    int64_t copyLen = ReadOfft(ctrlBytes + ctrlPos + 8);
    int64_t seekLen = ReadOfft(ctrlBytes + ctrlPos + 16);
    ctrlPos += 24;

    if (addLen < 0 || copyLen < 0) {
      if (error) {
        *error = MakePatchError(@"Negative add/copy length in control block");
      }
      return NO;
    }

    NSUInteger addCount = static_cast<NSUInteger>(addLen);
    NSUInteger copyCount = static_cast<NSUInteger>(copyLen);

    if (diffPos + addCount > diffData.length ||
        extraPos + copyCount > extraData.length ||
        outputPos + addCount + copyCount > static_cast<NSUInteger>(newSize)) {
      if (error) {
        *error = MakePatchError(@"BSDIFF40 stream is truncated");
      }
      return NO;
    }

    for (NSUInteger index = 0; index < addCount; index += 1) {
      if (oldPos < 0 || oldPos >= static_cast<int64_t>(baseData.length)) {
        if (error) {
          *error = MakePatchError(@"Old file offset out of bounds");
        }
        return NO;
      }

      uint8_t oldByte = baseBytes[oldPos];
      uint8_t deltaByte = diffBytes[diffPos + index];
      outputBytes[outputPos] =
          static_cast<uint8_t>((deltaByte + oldByte) & 0xFF);
      outputPos += 1;
      oldPos += 1;
    }
    diffPos += addCount;

    if (copyCount > 0) {
      memcpy(outputBytes + outputPos, extraBytes + extraPos, copyCount);
      outputPos += copyCount;
      extraPos += copyCount;
    }

    oldPos += seekLen;
  }

  if (![output writeToFile:outputPath options:NSDataWritingAtomic error:error]) {
    return NO;
  }

  return YES;
}

@end
