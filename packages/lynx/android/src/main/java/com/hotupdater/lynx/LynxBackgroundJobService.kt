package com.hotupdater.lynx

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.Log
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** Application-owned configuration shared by foreground hosts and OS jobs. */
interface LynxHostConfigurationProvider {
    fun createLynxHostConfiguration(): LynxHostConfiguration
    fun onLynxBackgroundResult(jobId: Int, result: Result<LynxBackgroundResult>) {}
}

/** Runs only when JobScheduler grants execution; it never starts a foreground Activity. */
class LynxBackgroundJobService : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val jobs = mutableMapOf<Int, Job>()

    override fun onStartJob(params: JobParameters): Boolean {
        val provider = application as? LynxHostConfigurationProvider ?: run {
            Log.e(TAG, "Application must implement LynxHostConfigurationProvider")
            return false
        }
        lateinit var work: Job
        work = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val result = try {
                    withTimeout(25_000) {
                        val configuration = provider.createLynxHostConfiguration()
                        val host = withContext(Dispatchers.IO) {
                            LynxRuntimeHost.get(applicationContext, configuration)
                        }
                        suspendCancellableCoroutine<Result<LynxBackgroundResult>> { continuation ->
                            val execution = host.runBackground(applicationContext) {
                                if (continuation.isActive) continuation.resume(it)
                            }
                            continuation.invokeOnCancellation { execution.close() }
                        }
                    }
                } catch (timeout: TimeoutCancellationException) {
                    Result.failure(timeout)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    Result.failure(error)
                }
                if (jobs[params.jobId] === work) provider.onLynxBackgroundResult(params.jobId, result)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                Log.e(TAG, "Lynx background result observer failed", error)
            } finally {
                if (jobs[params.jobId] === work) {
                    jobs.remove(params.jobId)
                    jobFinished(params, false)
                }
            }
        }
        jobs.put(params.jobId, work)?.cancel()
        work.start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        // The OS has ended this job's lifetime; its late callback cannot finish a replacement.
        jobs.remove(params.jobId)?.cancel()
        return false
    }

    override fun onDestroy() {
        jobs.clear()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "HotUpdaterLynx"

        /** Reserve a job ID in your application. Scheduling the same ID replaces the previous job. */
        @JvmStatic fun schedule(context: Context, jobId: Int): Boolean {
            val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            val job = JobInfo.Builder(jobId, ComponentName(context, LynxBackgroundJobService::class.java))
                .setMinimumLatency(0)
                .build()
            return scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS
        }
    }
}
