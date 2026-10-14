import Foundation

/// Checks that a text is exactly one JSON value (RFC 8259), as `JSON.parse`
/// accepts it. `JSONSerialization` also accepts some non-JSON syntax, such as
/// a trailing comma in an object, so the catalog parser checks here first.
/// Iterative, so deep nesting cannot overflow the stack.
enum StrictJson {
    static func isValid(_ text: String) -> Bool {
        var checker = Checker(bytes: Array(text.utf8))
        return checker.check()
    }

    private struct Checker {
        let bytes: [UInt8]
        var index = 0
        var containers: [UInt8] = []

        init(bytes: [UInt8]) {
            self.bytes = bytes
        }

        mutating func check() -> Bool {
            var expectValue = true
            while true {
                skipWhitespace()
                if expectValue {
                    switch peek() {
                    case UInt8(ascii: "{"):
                        index += 1
                        skipWhitespace()
                        if peek() == UInt8(ascii: "}") {
                            index += 1
                            expectValue = false
                        } else {
                            containers.append(UInt8(ascii: "{"))
                            if !member() { return false }
                        }
                    case UInt8(ascii: "["):
                        index += 1
                        skipWhitespace()
                        if peek() == UInt8(ascii: "]") {
                            index += 1
                            expectValue = false
                        } else {
                            containers.append(UInt8(ascii: "["))
                        }
                    case UInt8(ascii: "\""):
                        if !string() { return false }
                        expectValue = false
                    case UInt8(ascii: "t"):
                        if !literal("true") { return false }
                        expectValue = false
                    case UInt8(ascii: "f"):
                        if !literal("false") { return false }
                        expectValue = false
                    case UInt8(ascii: "n"):
                        if !literal("null") { return false }
                        expectValue = false
                    default:
                        if !number() { return false }
                        expectValue = false
                    }
                } else {
                    guard let container = containers.last else { return index == bytes.count }
                    switch peek() {
                    case UInt8(ascii: ","):
                        index += 1
                        if container == UInt8(ascii: "{") {
                            skipWhitespace()
                            if !member() { return false }
                        }
                        expectValue = true
                    case UInt8(ascii: "}") where container == UInt8(ascii: "{"),
                         UInt8(ascii: "]") where container == UInt8(ascii: "["):
                        index += 1
                        containers.removeLast()
                    default:
                        return false
                    }
                }
            }
        }

        /// An object member's key and colon; its value comes next.
        private mutating func member() -> Bool {
            guard peek() == UInt8(ascii: "\""), string() else { return false }
            skipWhitespace()
            guard peek() == UInt8(ascii: ":") else { return false }
            index += 1
            return true
        }

        private mutating func string() -> Bool {
            index += 1
            while index < bytes.count {
                let byte = bytes[index]
                index += 1
                if byte == UInt8(ascii: "\"") { return true }
                if byte < 0x20 { return false }
                if byte == UInt8(ascii: "\\") {
                    guard index < bytes.count else { return false }
                    let escape = bytes[index]
                    index += 1
                    switch escape {
                    case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"), UInt8(ascii: "b"),
                         UInt8(ascii: "f"), UInt8(ascii: "n"), UInt8(ascii: "r"), UInt8(ascii: "t"):
                        continue
                    case UInt8(ascii: "u"):
                        guard index + 4 <= bytes.count else { return false }
                        for _ in 0..<4 {
                            guard isHexDigit(bytes[index]) else { return false }
                            index += 1
                        }
                    default:
                        return false
                    }
                }
            }
            return false
        }

        private mutating func number() -> Bool {
            if peek() == UInt8(ascii: "-") { index += 1 }
            if peek() == UInt8(ascii: "0") {
                index += 1
            } else if let byte = peek(), (UInt8(ascii: "1")...UInt8(ascii: "9")).contains(byte) {
                skipDigits()
            } else {
                return false
            }
            if peek() == UInt8(ascii: ".") {
                index += 1
                guard isDigit(peek()) else { return false }
                skipDigits()
            }
            if peek() == UInt8(ascii: "e") || peek() == UInt8(ascii: "E") {
                index += 1
                if peek() == UInt8(ascii: "+") || peek() == UInt8(ascii: "-") { index += 1 }
                guard isDigit(peek()) else { return false }
                skipDigits()
            }
            return true
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

        private func isHexDigit(_ byte: UInt8) -> Bool {
            isDigit(byte) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
                || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(byte)
        }
    }
}
