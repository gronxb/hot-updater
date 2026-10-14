package com.hotupdater

/**
 * Checks that a text is exactly one JSON value (RFC 8259), as `JSON.parse`
 * accepts it. `org.json` also accepts comments, single quotes, unquoted keys,
 * trailing commas, and other non-JSON syntax, so the catalog parser checks
 * here first. Iterative, so deep nesting cannot overflow the stack.
 */
internal object StrictJson {
    fun isValid(text: String): Boolean = Checker(text).check()

    private class Checker(
        private val text: String,
    ) {
        private var index = 0
        private val containers = ArrayDeque<Char>()

        fun check(): Boolean {
            var expectValue = true
            while (true) {
                skipWhitespace()
                if (expectValue) {
                    when (peek()) {
                        '{' -> {
                            index++
                            skipWhitespace()
                            if (peek() == '}') {
                                index++
                                expectValue = false
                            } else {
                                containers.addLast('{')
                                if (!member()) return false
                            }
                        }
                        '[' -> {
                            index++
                            skipWhitespace()
                            if (peek() == ']') {
                                index++
                                expectValue = false
                            } else {
                                containers.addLast('[')
                            }
                        }
                        '"' -> {
                            if (!string()) return false
                            expectValue = false
                        }
                        't' -> if (literal("true")) expectValue = false else return false
                        'f' -> if (literal("false")) expectValue = false else return false
                        'n' -> if (literal("null")) expectValue = false else return false
                        else -> if (number()) expectValue = false else return false
                    }
                } else {
                    val container = containers.lastOrNull() ?: return index == text.length
                    when (peek()) {
                        ',' -> {
                            index++
                            if (container == '{') {
                                skipWhitespace()
                                if (!member()) return false
                            }
                            expectValue = true
                        }
                        '}' -> if (container == '{') {
                            index++
                            containers.removeLast()
                        } else {
                            return false
                        }
                        ']' -> if (container == '[') {
                            index++
                            containers.removeLast()
                        } else {
                            return false
                        }
                        else -> return false
                    }
                }
            }
        }

        /** An object member's key and colon; its value comes next. */
        private fun member(): Boolean {
            if (peek() != '"' || !string()) return false
            skipWhitespace()
            if (peek() != ':') return false
            index++
            return true
        }

        private fun string(): Boolean {
            index++
            while (index < text.length) {
                val char = text[index++]
                when {
                    char == '"' -> return true
                    char < ' ' -> return false
                    char == '\\' -> {
                        if (index >= text.length) return false
                        when (text[index++]) {
                            '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> Unit
                            'u' -> {
                                if (index + 4 > text.length) return false
                                repeat(4) { if (!isHexDigit(text[index++])) return false }
                            }
                            else -> return false
                        }
                    }
                }
            }
            return false
        }

        private fun number(): Boolean {
            if (peek() == '-') index++
            when {
                peek() == '0' -> index++
                peek() in '1'..'9' -> while (peek() in '0'..'9') index++
                else -> return false
            }
            if (peek() == '.') {
                index++
                if (peek() !in '0'..'9') return false
                while (peek() in '0'..'9') index++
            }
            if (peek() == 'e' || peek() == 'E') {
                index++
                if (peek() == '+' || peek() == '-') index++
                if (peek() !in '0'..'9') return false
                while (peek() in '0'..'9') index++
            }
            return true
        }

        private fun literal(word: String): Boolean {
            if (!text.startsWith(word, index)) return false
            index += word.length
            return true
        }

        private fun skipWhitespace() {
            while (index < text.length && text[index].let { it == ' ' || it == '\t' || it == '\n' || it == '\r' }) {
                index++
            }
        }

        private fun peek(): Char = if (index < text.length) text[index] else '\u0000'

        private fun isHexDigit(char: Char): Boolean = char in '0'..'9' || char in 'a'..'f' || char in 'A'..'F'
    }
}
