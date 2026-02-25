package com.hotupdater

import android.content.Context

/**
 * Utility class for string resource lookup operations
 */
object StringResourceUtils {
    /**
     * Resolves a string resource ID with namespace fallback.
     * Handles AGP 7.0+ where namespace and applicationId are decoupled.
     * @param context Application context
     * @param resourceName The string resource name to resolve
     * @return The resolved resource ID, or 0 if not found
     */
    fun getIdentifier(
        context: Context,
        resourceName: String,
    ): Int {
        var resourceId =
            context.resources.getIdentifier(
                resourceName,
                "string",
                context.packageName,
            )

        // Fallback: try namespace derived from Application class package
        if (resourceId == 0) {
            val appClassName = context.applicationInfo.className
            if (appClassName != null) {
                val namespace = appClassName.substringBeforeLast('.')
                if (namespace != context.packageName) {
                    resourceId =
                        context.resources.getIdentifier(
                            resourceName,
                            "string",
                            namespace,
                        )
                }
            }
        }

        return resourceId
    }
}
