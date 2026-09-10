package com.hotupdater

internal class HotUpdaterRecoveryState {
    data class Launch(
        val bundleId: String?,
        val shouldRollback: Boolean,
    )

    data class RecoveryRequest(
        val launch: Launch,
        val shouldRestart: Boolean,
    )

    private enum class RestartState { NONE, REQUESTED, SCHEDULED, FAILED }

    private var launch: Launch? = null
    private var restartState = RestartState.NONE
    private var contentAppeared = false

    @Synchronized
    fun start(
        bundleId: String?,
        shouldRollback: Boolean,
    ) {
        launch = Launch(bundleId, shouldRollback)
        restartState = RestartState.NONE
        contentAppeared = false
    }

    @Synchronized
    fun snapshot(): Launch? = launch

    @Synchronized
    fun stop() {
        launch = null
        restartState = RestartState.NONE
    }

    @Synchronized
    fun completeLaunch(): Launch? {
        val current = launch ?: return null
        if (contentAppeared || restartState != RestartState.NONE) return null
        contentAppeared = true
        launch = current.copy(shouldRollback = false)
        return current
    }

    @Synchronized
    fun requestRecovery(): RecoveryRequest? {
        val current = launch?.takeIf { it.shouldRollback } ?: return null
        val shouldRestart = restartState == RestartState.NONE || restartState == RestartState.FAILED
        if (shouldRestart) restartState = RestartState.REQUESTED
        return RecoveryRequest(current, shouldRestart)
    }

    @Synchronized
    fun finishRecoveryRequest(
        request: RecoveryRequest,
        started: Boolean,
    ) {
        if (launch !== request.launch) return
        restartState = if (started) RestartState.SCHEDULED else RestartState.FAILED
    }
}
