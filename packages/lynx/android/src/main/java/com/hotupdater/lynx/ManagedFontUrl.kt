package com.hotupdater.lynx

import com.hotupdater.lynx.internal.ManagedPaths
import java.net.IDN
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

internal object ManagedFontUrl {
    private const val HOST = "hot-updater-font.invalid"
    private const val PREFIX = "https://$HOST/"

    // Claim the reserved host before parsing the rest: an invalid owned URL
    // must fail locally instead of falling through to a host/network loader.
    fun owns(url: String): Boolean {
        val authority = url.trim().filterNot { it in "\t\r\n" }
            .substringAfter(':', "").trimStart('/', '\\')
            .takeWhile { it !in "/\\?#" }
        val host = authority.substringAfterLast('@').substringBefore(':')
        return runCatching { IDN.toASCII(URLDecoder.decode(host, "UTF-8")) }
            .getOrDefault(host).removeSuffix(".").equals(HOST, ignoreCase = true)
    }

    fun path(url: String): String {
        val uri = URI(url)
        val relative = requireNotNull(uri.path).removePrefix("/")
        val encoded = URLEncoder.encode(relative, "UTF-8")
            .replace("+", "%20").replace("%2F", "/")
            .replace("*", "%2A").replace("%7E", "~")
        require(
            uri.rawQuery != null && managedGenerationQuery(uri.rawQuery) &&
                uri.fragment == null &&
                url == "$PREFIX$encoded?${uri.rawQuery}" &&
                relative.none { it in "%?#" } &&
                ManagedPaths.normalize(relative) == relative,
        ) { "Invalid managed font URL" }
        return relative
    }
}
