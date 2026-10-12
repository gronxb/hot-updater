package com.hotupdater.lynx.sparkling

import android.os.Handler
import android.os.Looper
import com.tiktok.sparkling.method.registry.core.BridgePlatformType
import com.tiktok.sparkling.method.registry.core.IDLBridgeMethod
import com.tiktok.sparkling.method.registry.core.SparklingBridgeManager
import com.tiktok.sparkling.method.registry.core.model.idl.CompletionBlock
import com.tiktok.sparkling.method.registry.core.model.idl.IDLMethodBaseParamModel
import com.tiktok.sparkling.method.registry.core.utils.createXModel
import com.tiktok.sparkling.method.router.close.AbsRouterCloseMethodIDL
import com.tiktok.sparkling.method.router.open.AbsRouterOpenMethodIDL
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

internal data class ManagedSparklingRoute(
    val pageEntry: String,
    val parameters: Map<String, String>,
) {
    companion object {
        private const val PREFIX = "hybrid://lynxview_page?"
        private val FORBIDDEN_KEYS = setOf(
            "baseScheme",
            "replace",
            "replaceType",
            "useSysBrowser",
            "animated",
            "interceptor",
            "extra",
        )
        private val PAGE_ENTRY = Regex(
            "^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/)*" +
                "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\\.lynx\\.bundle$",
        )

        fun parse(
            value: String,
            allowlist: Set<String>,
        ): ManagedSparklingRoute {
            require(value.toByteArray(StandardCharsets.UTF_8).size <= MAX_ROUTE_BYTES) {
                "Managed Sparkling route exceeds the byte limit"
            }
            require(value.startsWith(PREFIX) && value.length > PREFIX.length) {
                "Unsupported managed Sparkling route"
            }
            val rawQuery = value.substring(PREFIX.length)
            require('#' !in rawQuery && '?' !in rawQuery) {
                "Malformed managed Sparkling route"
            }
            val items = rawQuery.split('&').map { item ->
                require(item.isNotEmpty()) { "Empty managed route query item" }
                val separator = item.indexOf('=')
                val rawName = if (separator < 0) item else item.substring(0, separator)
                val rawValue = if (separator < 0) "" else item.substring(separator + 1)
                decodeForm(rawName) to decodeForm(rawValue)
            }
            require(items.joinToString("&") { (name, item) ->
                "${encodeForm(name)}=${encodeForm(item)}"
            } == rawQuery) { "Managed route query is not canonical" }
            require(items.first().first == "bundle") {
                "The first managed route query item must be bundle"
            }
            require(items.count { it.first == "bundle" } == 1) {
                "Managed route must contain exactly one bundle"
            }
            require(items.none { it.first == "url" }) {
                "Development URL routes are not managed OTA pages"
            }
            var parameterBytes = 0
            items.forEach { (name, item) ->
                require(name.isNotEmpty()) {
                    "Managed route parameter name is empty"
                }
                val nameBytes = name.toByteArray(StandardCharsets.UTF_8).size
                val valueBytes = item.toByteArray(StandardCharsets.UTF_8).size
                require(nameBytes <= MAX_PARAMETER_KEY_BYTES) {
                    "Managed route parameter name exceeds the byte limit"
                }
                require(valueBytes <= MAX_PARAMETER_VALUE_BYTES) {
                    "Managed route parameter value exceeds the byte limit"
                }
                parameterBytes += nameBytes + valueBytes
                require(parameterBytes <= MAX_PARAMETER_BYTES) {
                    "Managed route parameters exceed the aggregate byte limit"
                }
            }
            val page = items.first().second
            require(PAGE_ENTRY.matches(page) && page in allowlist) {
                "Unknown or invalid managed page entry"
            }
            val parameters = linkedMapOf<String, String>()
            require(items.size - 1 <= MAX_CUSTOM_PARAMETERS) {
                "Too many managed route parameters"
            }
            items.drop(1).forEach { (name, item) ->
                require(
                    name != "bundle" && name != "url" &&
                        name !in FORBIDDEN_KEYS,
                ) { "Reserved managed route parameter" }
                require(parameters.put(name, item) == null) {
                    "Duplicate managed route parameter"
                }
            }
            return ManagedSparklingRoute(page, parameters)
        }

        private fun decodeForm(value: String): String {
            val bytes = ByteArrayOutputStream(value.length)
            var index = 0
            while (index < value.length) {
                when (val character = value[index]) {
                    '+' -> {
                        bytes.write(' '.code)
                        index += 1
                    }
                    '%' -> {
                        require(index + 2 < value.length) {
                            "Malformed managed route escape"
                        }
                        val high = value[index + 1].digitToIntOrNull(16)
                        val low = value[index + 2].digitToIntOrNull(16)
                        require(high != null && low != null) {
                            "Malformed managed route escape"
                        }
                        bytes.write(high * 16 + low)
                        index += 3
                    }
                    else -> {
                        require(character.code in 0x20..0x7e) {
                            "Managed route query must be ASCII encoded"
                        }
                        bytes.write(character.code)
                        index += 1
                    }
                }
            }
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray()))
                .toString()
        }

        private fun encodeForm(value: String): String {
            val encoded = StringBuilder()
            value.toByteArray(StandardCharsets.UTF_8).forEach { byte ->
                val unsigned = byte.toInt() and 0xff
                when {
                    unsigned == 0x20 -> encoded.append('+')
                    unsigned in 'a'.code..'z'.code ||
                        unsigned in 'A'.code..'Z'.code ||
                        unsigned in '0'.code..'9'.code ||
                        unsigned == '*'.code || unsigned == '-'.code ||
                        unsigned == '.'.code || unsigned == '_'.code ->
                        encoded.append(unsigned.toChar())
                    else -> encoded.append('%')
                        .append(HEX[unsigned ushr 4])
                        .append(HEX[unsigned and 15])
                }
            }
            return encoded.toString()
        }

        private const val HEX = "0123456789ABCDEF"
        private const val MAX_ROUTE_BYTES = 4096
        private const val MAX_CUSTOM_PARAMETERS = 32
        private const val MAX_PARAMETER_KEY_BYTES = 128
        private const val MAX_PARAMETER_VALUE_BYTES = 1024
        private const val MAX_PARAMETER_BYTES = 2048
    }
}

internal data class ManagedOpenOptions(val animated: Boolean) {
    companion object {
        private val KEYS = setOf(
            "scheme",
            "replace",
            "replaceType",
            "useSysBrowser",
            "animated",
            "interceptor",
            "extra",
        )

        fun parse(params: Map<String, Any?>): Pair<String, ManagedOpenOptions> {
            require(params.keys.all { it in KEYS }) {
                "Unknown managed router.open option"
            }
            val scheme = params["scheme"]
            require(scheme is String) {
                "Managed router.open requires a scheme"
            }
            require(scheme.isNotEmpty() && scheme == scheme.trim()) {
                "Managed router.open scheme must be canonical"
            }
            if ("replace" in params) {
                require(params["replace"] == false) {
                    "Managed page replacement is unsupported"
                }
            }
            require("replaceType" !in params && "interceptor" !in params) {
                "Managed router replacement and interceptors are unsupported"
            }
            if ("useSysBrowser" in params) {
                require(params["useSysBrowser"] == false) {
                    "Managed pages cannot use the system browser"
                }
            }
            require("extra" !in params) {
                "Managed router extra options are unsupported"
            }
            val animated = if ("animated" in params) {
                val value = params["animated"]
                require(value is Boolean) {
                    "Managed router animation must be boolean"
                }
                value
            } else true
            return scheme to ManagedOpenOptions(animated)
        }
    }
}

internal data class ManagedCloseOptions(
    val containerId: String?,
    val animated: Boolean,
) {
    companion object {
        fun parse(params: Map<String, Any?>): ManagedCloseOptions {
            require(params.keys.all { it == "containerID" || it == "animated" }) {
                "Unknown managed router.close option"
            }
            val containerId = if ("containerID" in params) {
                val value = params["containerID"]
                require(value is String) {
                    "Managed containerID must be a string"
                }
                value
            } else null
            val animated = if ("animated" in params) {
                val value = params["animated"]
                require(value is Boolean) {
                    "Managed close animation must be boolean"
                }
                value
            } else true
            return ManagedCloseOptions(containerId, animated)
        }
    }
}

internal object ManagedSparklingBridge {
    fun register() {
        SparklingBridgeManager.registerIDLMethod(
            ManagedRouterOpenMethod::class.java,
            BridgePlatformType.ALL,
            SparklingBridgeManager.DEFAULT_NAMESPACE,
        )
        SparklingBridgeManager.registerIDLMethod(
            ManagedRouterCloseMethod::class.java,
            BridgePlatformType.ALL,
            SparklingBridgeManager.DEFAULT_NAMESPACE,
        )
    }
}

private val managedRouterMainHandler = Handler(Looper.getMainLooper())

private fun runManagedRouterOnMainThread(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
        block()
    } else {
        managedRouterMainHandler.post(block)
    }
}

private fun IDLMethodBaseParamModel.asManagedParams(): Map<String, Any?> {
    val json = toJSON()
    return json.keys().asSequence().associateWith(json::get)
}

internal class ManagedRouterOpenMethod : AbsRouterOpenMethodIDL() {
    override fun handle(
        params: IDLMethodOpenParamModel,
        callback: CompletionBlock<IDLMethodOpenResultModel>,
        type: BridgePlatformType,
    ) {
        runManagedRouterOnMainThread {
            runCatching {
                require(type == BridgePlatformType.LYNX) {
                    "Managed pages require a Lynx source"
                }
                val bridge = checkNotNull(getSDKContext()) {
                    "Managed router source context is unavailable"
                }
                val (scheme, options) = ManagedOpenOptions.parse(
                    params.asManagedParams(),
                )
                val host =
                    ManagedSparklingHostRegistry.hostForBridgeContext(bridge)
                        ?: error("Managed router source is stale")
                host.open(bridge, scheme, options.animated)
            }.fold(
                onSuccess = { accepted ->
                    if (accepted) {
                        callback.onSuccess(
                            IDLMethodOpenResultModel::class.java.createXModel(
                                getSDKContext()?.containerID,
                            ),
                        )
                    } else {
                        callback.onFailure(
                            IDLBridgeMethod.INVALID_PARAM,
                            "Managed navigation rejected",
                            null,
                        )
                    }
                },
                onFailure = { error ->
                    callback.onFailure(
                        IDLBridgeMethod.INVALID_PARAM,
                        error.message ?: "Managed navigation rejected",
                        null,
                    )
                },
            )
        }
    }
}

internal class ManagedRouterCloseMethod : AbsRouterCloseMethodIDL() {
    override fun handle(
        params: IDLMethodCloseParamModel,
        callback: CompletionBlock<IDLMethodCloseResultModel>,
        type: BridgePlatformType,
    ) {
        runManagedRouterOnMainThread {
            runCatching {
                require(type == BridgePlatformType.LYNX) {
                    "Managed pages require a Lynx source"
                }
                val options = ManagedCloseOptions.parse(
                    params.asManagedParams(),
                )
                val bridge = checkNotNull(getSDKContext()) {
                    "Managed router source context is unavailable"
                }
                val host =
                    ManagedSparklingHostRegistry.hostForBridgeContext(bridge)
                        ?: error("Managed router source is stale")
                host.close(
                    bridge,
                    options.containerId,
                    options.animated,
                )
            }.fold(
                onSuccess = { accepted ->
                    if (accepted) {
                        callback.onSuccess(
                            IDLMethodCloseResultModel::class.java.createXModel(
                                getSDKContext()?.containerID,
                            ),
                        )
                    } else {
                        callback.onFailure(
                            IDLBridgeMethod.INVALID_PARAM,
                            "Managed navigation rejected",
                            null,
                        )
                    }
                },
                onFailure = { error ->
                    callback.onFailure(
                        IDLBridgeMethod.INVALID_PARAM,
                        error.message ?: "Managed navigation rejected",
                        null,
                    )
                },
            )
        }
    }
}
