import Foundation

/// Parses exactly one JSON value (RFC 8259) as `JSON.parse` does, into
/// Foundation values: `[String: Any]`, `[Any]`, `String`, `NSNumber` (a
/// `Double`, or a Boolean) and `NSNull`. `JSONSerialization` accepts some
/// non-JSON syntax, such as a trailing comma in an object, and rejects some
/// JSON, such as an unpaired `\ud800` escape or a number that overflows to
/// infinity, so update responses are parsed here instead.
///
/// Like `JSON.parse`, a duplicate key keeps its last value and an overflowing
/// number is infinite. Iterative, so deep nesting cannot overflow the stack.
///
/// JavaScript compares strings by UTF-16 code units, but Swift strings
/// compare canonically: `"scope\u{212A}ey"` (Kelvin sign) equals `"scopeKey"`,
/// and a Swift string cannot hold an unpaired surrogate at all.
/// - An object key that is not its own canonical decomposition, or that has
///   an unpaired surrogate, is stored escaped. Lookups by plain names match
///   only that exact key, and `originalKey` recovers the escaped one.
/// - A string value with an unpaired surrogate is an `UnpairedString`, its
///   code units as `JSON.parse` keeps them; every other value is a `String`
///   exactly as the JSON spells it.
enum StrictJson {
    /// Starts every escaped key. A key that starts with it is escaped too.
    private static let escapedKeyPrefix = "\u{E000}"

    /// The object key under which `key` is stored.
    static func storedKey(_ key: String) -> String {
        storedKey(Array(key.utf16))
    }

    private static func storedKey(_ units: [UInt16]) -> String {
        let key = String(decoding: units, as: UTF16.self)
        if !needsEscape(units),
           key.utf16.elementsEqual(key.decomposedStringWithCanonicalMapping.utf16) {
            return key
        }
        return escaped(units)
    }

    /// A string value with an unpaired surrogate, which a Swift `String`
    /// cannot hold: its UTF-16 code units, as `JSON.parse` keeps them.
    struct UnpairedString: Hashable {
        let units: [UInt16]

        /// The text, each unpaired surrogate as U+FFFD.
        var text: String { String(decoding: units, as: UTF16.self) }
    }

    /// The parsed value of a string with `units`.
    private static func storedValue(_ units: [UInt16]) -> Any {
        hasUnpairedSurrogate(units) ? UnpairedString(units: units) : String(decoding: units, as: UTF16.self)
    }

    /// Whether a Swift string would lose `units`, or they could be mistaken
    /// for an escaped key.
    private static func needsEscape(_ units: [UInt16]) -> Bool {
        units.first == 0xE000 || hasUnpairedSurrogate(units)
    }

    private static func hasUnpairedSurrogate(_ units: [UInt16]) -> Bool {
        var index = 0
        while index < units.count {
            let unit = units[index]
            if (0xD800...0xDBFF).contains(unit) {
                guard index + 1 < units.count, (0xDC00...0xDFFF).contains(units[index + 1]) else {
                    return true
                }
                index += 2
            } else if (0xDC00...0xDFFF).contains(unit) {
                return true
            } else {
                index += 1
            }
        }
        return false
    }

    private static func escaped(_ units: [UInt16]) -> String {
        escapedKeyPrefix + units.map { String(format: "%04x", $0) }.joined()
    }

    /// The key as the JSON text spelled it, for a key read from a parsed
    /// object; an unpaired surrogate becomes U+FFFD.
    static func originalKey(_ storedKey: String) -> String {
        guard storedKey.hasPrefix(escapedKeyPrefix) else { return storedKey }
        let hex = Array(storedKey.dropFirst(escapedKeyPrefix.count))
        var units: [UInt16] = []
        var index = 0
        while index + 4 <= hex.count, let unit = UInt16(String(hex[index..<(index + 4)]), radix: 16) {
            units.append(unit)
            index += 4
        }
        return String(decoding: units, as: UTF16.self)
    }

    static func isValid(_ text: String) -> Bool {
        parse(text) != nil
    }

    /// The value of `text`, or nil when `text` is not exactly one JSON value.
    static func parse(_ text: String) -> Any? {
        var parser = Parser(bytes: Array(text.utf8))
        return parser.parse()
    }

    private final class Container {
        let isObject: Bool
        var object: [String: Any] = [:]
        var array: [Any] = []
        var key = ""

        init(isObject: Bool) {
            self.isObject = isObject
        }

        var value: Any {
            isObject ? object : array
        }

        func add(_ value: Any) {
            if isObject {
                object[key] = value
            } else {
                array.append(value)
            }
        }
    }

    private struct Parser {
        let bytes: [UInt8]
        var index = 0
        var containers: [Container] = []

        init(bytes: [UInt8]) {
            self.bytes = bytes
        }

        mutating func parse() -> Any? {
            var expectValue = true
            var result: Any?
            // Adds a finished value to the open container, or ends the parse.
            func finish(_ value: Any, _ containers: [Container]) -> Bool {
                if let container = containers.last {
                    container.add(value)
                    return false
                }
                result = value
                return true
            }

            while true {
                skipWhitespace()
                if expectValue {
                    let value: Any
                    switch peek() {
                    case UInt8(ascii: "{"):
                        index += 1
                        skipWhitespace()
                        if peek() == UInt8(ascii: "}") {
                            index += 1
                            value = [String: Any]()
                        } else {
                            let container = Container(isObject: true)
                            guard let key = member() else { return nil }
                            container.key = key
                            containers.append(container)
                            continue
                        }
                    case UInt8(ascii: "["):
                        index += 1
                        skipWhitespace()
                        if peek() == UInt8(ascii: "]") {
                            index += 1
                            value = [Any]()
                        } else {
                            containers.append(Container(isObject: false))
                            continue
                        }
                    case UInt8(ascii: "\""):
                        guard let units = string() else { return nil }
                        value = StrictJson.storedValue(units)
                    case UInt8(ascii: "t"):
                        guard literal("true") else { return nil }
                        value = NSNumber(value: true)
                    case UInt8(ascii: "f"):
                        guard literal("false") else { return nil }
                        value = NSNumber(value: false)
                    case UInt8(ascii: "n"):
                        guard literal("null") else { return nil }
                        value = NSNull()
                    default:
                        guard let number = number() else { return nil }
                        value = NSNumber(value: number)
                    }
                    expectValue = false
                    if finish(value, containers) {
                        skipWhitespace()
                        return index == bytes.count ? result : nil
                    }
                } else {
                    guard let container = containers.last else { return nil }
                    switch peek() {
                    case UInt8(ascii: ","):
                        index += 1
                        if container.isObject {
                            skipWhitespace()
                            guard let key = member() else { return nil }
                            container.key = key
                        }
                        expectValue = true
                    case UInt8(ascii: "}") where container.isObject,
                         UInt8(ascii: "]") where !container.isObject:
                        index += 1
                        containers.removeLast()
                        if finish(container.value, containers) {
                            skipWhitespace()
                            return index == bytes.count ? result : nil
                        }
                    default:
                        return nil
                    }
                }
            }
        }

        /// An object member's stored key and colon; its value comes next.
        private mutating func member() -> String? {
            guard peek() == UInt8(ascii: "\""), let key = string() else { return nil }
            skipWhitespace()
            guard peek() == UInt8(ascii: ":") else { return nil }
            index += 1
            return StrictJson.storedKey(key)
        }

        /// A string's UTF-16 code units, as JSON.parse keeps them.
        private mutating func string() -> [UInt16]? {
            index += 1
            var units: [UInt16] = []
            var runStart = index
            // Appends the unescaped UTF-8 bytes read since the last escape.
            func flush(_ end: Int) {
                if end > runStart {
                    units.append(contentsOf: String(decoding: bytes[runStart..<end], as: UTF8.self).utf16)
                }
            }
            while index < bytes.count {
                let byte = bytes[index]
                if byte == UInt8(ascii: "\"") {
                    flush(index)
                    index += 1
                    return units
                }
                if byte < 0x20 { return nil }
                if byte != UInt8(ascii: "\\") {
                    index += 1
                    continue
                }
                flush(index)
                index += 1
                guard index < bytes.count else { return nil }
                let escape = bytes[index]
                index += 1
                switch escape {
                case UInt8(ascii: "\""): units.append(0x22)
                case UInt8(ascii: "\\"): units.append(0x5C)
                case UInt8(ascii: "/"): units.append(0x2F)
                case UInt8(ascii: "b"): units.append(0x08)
                case UInt8(ascii: "f"): units.append(0x0C)
                case UInt8(ascii: "n"): units.append(0x0A)
                case UInt8(ascii: "r"): units.append(0x0D)
                case UInt8(ascii: "t"): units.append(0x09)
                case UInt8(ascii: "u"):
                    guard index + 4 <= bytes.count else { return nil }
                    var unit: UInt16 = 0
                    for _ in 0..<4 {
                        guard let digit = hexValue(bytes[index]) else { return nil }
                        unit = unit << 4 | UInt16(digit)
                        index += 1
                    }
                    units.append(unit)
                default:
                    return nil
                }
                runStart = index
            }
            return nil
        }

        private mutating func number() -> Double? {
            let start = index
            if peek() == UInt8(ascii: "-") { index += 1 }
            if peek() == UInt8(ascii: "0") {
                index += 1
            } else if let byte = peek(), (UInt8(ascii: "1")...UInt8(ascii: "9")).contains(byte) {
                skipDigits()
            } else {
                return nil
            }
            if peek() == UInt8(ascii: ".") {
                index += 1
                guard isDigit(peek()) else { return nil }
                skipDigits()
            }
            if peek() == UInt8(ascii: "e") || peek() == UInt8(ascii: "E") {
                index += 1
                if peek() == UInt8(ascii: "+") || peek() == UInt8(ascii: "-") { index += 1 }
                guard isDigit(peek()) else { return nil }
                skipDigits()
            }
            // An overflowing literal is infinite, as in JSON.parse.
            return Double(String(decoding: bytes[start..<index], as: UTF8.self))
        }

        private mutating func literal(_ word: String) -> Bool {
            let wordBytes = Array(word.utf8)
            guard index + wordBytes.count <= bytes.count,
                  Array(bytes[index..<(index + wordBytes.count)]) == wordBytes else { return false }
            index += wordBytes.count
            return true
        }

        private mutating func skipWhitespace() {
            while let byte = peek(),
                  byte == UInt8(ascii: " ") || byte == UInt8(ascii: "\t") ||
                  byte == UInt8(ascii: "\n") || byte == UInt8(ascii: "\r") {
                index += 1
            }
        }

        private mutating func skipDigits() {
            while isDigit(peek()) { index += 1 }
        }

        private func peek() -> UInt8? {
            index < bytes.count ? bytes[index] : nil
        }

        private func isDigit(_ byte: UInt8?) -> Bool {
            guard let byte else { return false }
            return (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
        }

        private func hexValue(_ byte: UInt8) -> UInt8? {
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): return byte - UInt8(ascii: "0")
            case UInt8(ascii: "a")...UInt8(ascii: "f"): return byte - UInt8(ascii: "a") + 10
            case UInt8(ascii: "A")...UInt8(ascii: "F"): return byte - UInt8(ascii: "A") + 10
            default: return nil
            }
        }
    }
}
