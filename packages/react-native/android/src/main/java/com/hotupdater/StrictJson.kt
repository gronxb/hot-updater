package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject

/**
 * Parses exactly one JSON value (RFC 8259) as `JSON.parse` does, into
 * `org.json` values. `org.json` also accepts comments, single quotes, unquoted
 * keys, trailing commas, and other non-JSON syntax, and Android's
 * `JSONObject` rejects a number that overflows to infinity, which `JSON.parse`
 * accepts, so update responses are parsed here instead. Iterative, and a
 * value nested deeper than [MAX_DEPTH], far deeper than any Hot Updater
 * response, is rejected, as on iOS, where releasing a deep value recurses.
 */
internal object StrictJson {
    /** The deepest nesting of arrays and objects a parsed value may have. */
    const val MAX_DEPTH = 128

    /**
     * Stands for a number that overflows to infinity, which `JSONObject`
     * cannot hold. It is neither a number, a string, nor null, so a known
     * field that reads it fails as `Infinity` fails in JavaScript.
     */
    object NonFiniteNumber

    fun isValid(text: String): Boolean = Checker(text).check()

    /** The value of [text], or null when [text] is not exactly one JSON value. */
    fun parse(text: String): Any? {
        if (!isValid(text)) return null
        return Builder(text).build()
    }

    /** Builds the value of a text [Checker] accepted. */
    private class Builder(
        private val text: String,
    ) {
        private var index = 0

        private class Container(
            val value: Any,
        ) {
            var key = ""

            fun add(item: Any) {
                when (value) {
                    is JSONObject -> value.put(key, item)
                    is JSONArray -> value.put(item)
                }
            }
        }

        fun build(): Any {
            val containers = ArrayDeque<Container>()
            var expectValue = true
            while (true) {
                skipWhitespace()
                if (expectValue) {
                    val value: Any =
                        when (text[index]) {
                            '{' -> {
                                index++
                                skipWhitespace()
                                if (text[index] == '}') {
                                    index++
                                    JSONObject()
                                } else {
                                    containers.addLast(Container(JSONObject()).apply { key = member() })
                                    continue
                                }
                            }

                            '[' -> {
                                index++
                                skipWhitespace()
                                if (text[index] == ']') {
                                    index++
                                    JSONArray()
                                } else {
                                    containers.addLast(Container(JSONArray()))
                                    continue
                                }
                            }

                            '"' -> {
                                string()
                            }

                            't' -> {
                                literal("true", true)
                            }

                            'f' -> {
                                literal("false", false)
                            }

                            'n' -> {
                                literal("null", JSONObject.NULL)
                            }

                            else -> {
                                number()
                            }
                        }
                    expectValue = false
                    val container = containers.lastOrNull() ?: return value
                    container.add(value)
                } else {
                    val container = containers.last()
                    when (text[index++]) {
                        ',' -> {
                            if (container.value is JSONObject) {
                                skipWhitespace()
                                container.key = member()
                            }
                            expectValue = true
                        }

                        else -> {
                            // The closing bracket the checker matched.
                            containers.removeLast()
                            val parent = containers.lastOrNull() ?: return container.value
                            parent.add(container.value)
                        }
                    }
                }
            }
        }

        private fun member(): String {
            val key = string()
            skipWhitespace()
            index++ // ':'
            return key
        }

        private fun string(): String {
            index++
            val builder = StringBuilder()
            while (true) {
                val char = text[index++]
                when (char) {
                    '"' -> {
                        return builder.toString()
                    }

                    '\\' -> {
                        when (val escape = text[index++]) {
                            'b' -> {
                                builder.append('\b')
                            }

                            'f' -> {
                                builder.append('\u000C')
                            }

                            'n' -> {
                                builder.append('\n')
                            }

                            'r' -> {
                                builder.append('\r')
                            }

                            't' -> {
                                builder.append('\t')
                            }

                            'u' -> {
                                builder.append(text.substring(index, index + 4).toInt(16).toChar())
                                index += 4
                            }

                            else -> {
                                builder.append(escape)
                            }
                        }
                    }

                    else -> {
                        builder.append(char)
                    }
                }
            }
        }

        private fun number(): Any {
            val start = index
            while (index < text.length && text[index] in "+-0123456789.eE") index++
            val value = text.substring(start, index).toDouble()
            return if (value.isInfinite()) NonFiniteNumber else value
        }

        private fun literal(
            word: String,
            value: Any,
        ): Any {
            index += word.length
            return value
        }

        private fun skipWhitespace() {
            while (index < text.length && text[index].let { it == ' ' || it == '\t' || it == '\n' || it == '\r' }) {
                index++
            }
        }
    }

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
                            if (containers.size >= MAX_DEPTH) return false
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
                            if (containers.size >= MAX_DEPTH) return false
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

                        't' -> {
                            if (literal("true")) expectValue = false else return false
                        }

                        'f' -> {
                            if (literal("false")) expectValue = false else return false
                        }

                        'n' -> {
                            if (literal("null")) expectValue = false else return false
                        }

                        else -> {
                            if (number()) expectValue = false else return false
                        }
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

                        '}' -> {
                            if (container == '{') {
                                index++
                                containers.removeLast()
                            } else {
                                return false
                            }
                        }

                        ']' -> {
                            if (container == '[') {
                                index++
                                containers.removeLast()
                            } else {
                                return false
                            }
                        }

                        else -> {
                            return false
                        }
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
                    char == '"' -> {
                        return true
                    }

                    char < ' ' -> {
                        return false
                    }

                    char == '\\' -> {
                        if (index >= text.length) return false
                        when (text[index++]) {
                            '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> {
                                Unit
                            }

                            'u' -> {
                                if (index + 4 > text.length) return false
                                repeat(4) { if (!isHexDigit(text[index++])) return false }
                            }

                            else -> {
                                return false
                            }
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
