import Foundation
import SWCompression

enum BspatchError: Error {
    case invalidHeader
    case invalidMagic
    case invalidBounds
    case invalidControl
    case outputMismatch
}

/**
 * BSDIFF40 patch applier used by OTA v2 incremental flow.
 */
enum Bspatch {
    private static let headerSize = 32
    private static let magic = "BSDIFF40"

    static func apply(base: Data, patch: Data) throws -> Data {
        guard patch.count >= headerSize else {
            throw BspatchError.invalidHeader
        }

        let magicData = patch.subdata(in: 0..<8)
        guard String(data: magicData, encoding: .utf8) == magic else {
            throw BspatchError.invalidMagic
        }

        let ctrlLen = try readOfft(from: patch, offset: 8)
        let diffLen = try readOfft(from: patch, offset: 16)
        let newSize = try readOfft(from: patch, offset: 24)
        guard ctrlLen >= 0, diffLen >= 0, newSize >= 0 else {
            throw BspatchError.invalidHeader
        }

        let ctrlLength = Int(ctrlLen)
        let diffLength = Int(diffLen)
        let outputLength = Int(newSize)

        let ctrlStart = headerSize
        let ctrlEnd = ctrlStart + ctrlLength
        let diffEnd = ctrlEnd + diffLength
        guard ctrlEnd <= patch.count, diffEnd <= patch.count else {
            throw BspatchError.invalidBounds
        }

        let ctrlCompressed = patch.subdata(in: ctrlStart..<ctrlEnd)
        let diffCompressed = patch.subdata(in: ctrlEnd..<diffEnd)
        let extraCompressed = patch.subdata(in: diffEnd..<patch.count)

        let ctrlData = try BZip2Archive.unarchive(archive: ctrlCompressed)
        let diffData = try BZip2Archive.unarchive(archive: diffCompressed)
        let extraData = try BZip2Archive.unarchive(archive: extraCompressed)

        var ctrlCursor = 0
        var diffCursor = 0
        var extraCursor = 0
        var oldPos: Int64 = 0
        var output = Data()
        output.reserveCapacity(outputLength)

        while output.count < outputLength {
            guard ctrlCursor + 24 <= ctrlData.count else {
                throw BspatchError.invalidControl
            }

            let addLen = try readOfft(from: ctrlData, offset: ctrlCursor)
            let copyLen = try readOfft(from: ctrlData, offset: ctrlCursor + 8)
            let seekLen = try readOfft(from: ctrlData, offset: ctrlCursor + 16)
            ctrlCursor += 24

            guard addLen >= 0, copyLen >= 0 else {
                throw BspatchError.invalidControl
            }

            let addLength = Int(addLen)
            let copyLength = Int(copyLen)

            guard diffCursor + addLength <= diffData.count else {
                throw BspatchError.invalidControl
            }
            for index in 0..<addLength {
                guard oldPos >= 0, oldPos < Int64(base.count) else {
                    throw BspatchError.invalidControl
                }
                let deltaByte = Int(diffData[diffCursor + index])
                let baseByte = Int(base[Int(oldPos)])
                let nextByte = UInt8((deltaByte + baseByte) & 0xFF)
                output.append(nextByte)
                oldPos += 1
            }
            diffCursor += addLength

            guard extraCursor + copyLength <= extraData.count else {
                throw BspatchError.invalidControl
            }
            output.append(extraData.subdata(in: extraCursor..<(extraCursor + copyLength)))
            extraCursor += copyLength

            oldPos += seekLen

            if output.count > outputLength {
                throw BspatchError.outputMismatch
            }
        }

        guard output.count == outputLength else {
            throw BspatchError.outputMismatch
        }

        return output
    }

    private static func readOfft(from data: Data, offset: Int) throws -> Int64 {
        guard offset + 8 <= data.count else {
            throw BspatchError.invalidHeader
        }

        let bytes = data.subdata(in: offset..<(offset + 8))
        var raw: UInt64 = 0
        for (index, byte) in bytes.enumerated() {
            raw |= UInt64(byte) << UInt64(index * 8)
        }

        if (raw & (1 << 63)) == 0 {
            return Int64(raw)
        }
        return -Int64(raw & 0x7FFF_FFFF_FFFF_FFFF)
    }
}
