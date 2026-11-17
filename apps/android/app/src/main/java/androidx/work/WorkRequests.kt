package androidx.work

import java.util.UUID
import java.util.concurrent.TimeUnit

enum class NetworkType { NOT_REQUIRED, CONNECTED, UNMETERED, NOT_ROAMING, METERED }

enum class BackoffPolicy { EXPONENTIAL, LINEAR }

enum class ExistingWorkPolicy { REPLACE, KEEP, APPEND, APPEND_OR_REPLACE }

enum class ExistingPeriodicWorkPolicy { REPLACE, KEEP, UPDATE }

class Constraints internal constructor() {
    var requiredNetworkType: NetworkType = NetworkType.NOT_REQUIRED
        internal set

    class Builder {
        private val constraints = Constraints()

        fun setRequiredNetworkType(networkType: NetworkType): Builder {
            constraints.requiredNetworkType = networkType
            return this
        }

        fun build(): Constraints = constraints
    }
}

class OneTimeWorkRequest internal constructor(val id: UUID = UUID.randomUUID())

class PeriodicWorkRequest internal constructor(val id: UUID = UUID.randomUUID())

class OneTimeWorkRequestBuilder<W : ListenableWorker> {
    fun setBackoffCriteria(
        backoffPolicy: BackoffPolicy,
        backoffDelay: Long,
        timeUnit: TimeUnit,
    ): OneTimeWorkRequestBuilder<W> = this

    /** API-kompatibel zu WorkManager 2.9.1 (CX-094: Netzwerkbedingung des Uploads). */
    fun setConstraints(constraints: Constraints): OneTimeWorkRequestBuilder<W> = this

    fun build(): OneTimeWorkRequest = OneTimeWorkRequest()
}

class PeriodicWorkRequestBuilder<W : ListenableWorker>(
    private val repeatInterval: Long,
    private val repeatIntervalTimeUnit: TimeUnit,
) {
    private var backoffPolicy: BackoffPolicy = BackoffPolicy.EXPONENTIAL
    private var backoffDelay: Long = 10L
    private var backoffTimeUnit: TimeUnit = TimeUnit.SECONDS
    private var constraints: Constraints = Constraints.Builder().build()

    fun setConstraints(constraints: Constraints): PeriodicWorkRequestBuilder<W> {
        this.constraints = constraints
        return this
    }

    fun setBackoffCriteria(
        backoffPolicy: BackoffPolicy,
        backoffDelay: Long,
        timeUnit: TimeUnit,
    ): PeriodicWorkRequestBuilder<W> {
        this.backoffPolicy = backoffPolicy
        this.backoffDelay = backoffDelay
        this.backoffTimeUnit = timeUnit
        return this
    }

    fun build(): PeriodicWorkRequest {
        require(repeatIntervalTimeUnit.toMinutes(repeatInterval) >= 15L) {
            "Periodische Arbeit muss mindestens 15 Minuten betragen."
        }
        return PeriodicWorkRequest()
    }
}

