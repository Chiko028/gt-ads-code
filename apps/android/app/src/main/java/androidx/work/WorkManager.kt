package androidx.work

import android.content.Context
import java.util.UUID

class WorkInfo(val id: UUID, val state: State) {
    enum class State { ENQUEUED, RUNNING, SUCCEEDED, FAILED, BLOCKED, CANCELLED }
}

abstract class WorkManager {
    abstract fun enqueueUniqueWork(name: String, policy: ExistingWorkPolicy, request: OneTimeWorkRequest)

    abstract fun enqueueUniquePeriodicWork(
        name: String,
        policy: ExistingPeriodicWorkPolicy,
        request: PeriodicWorkRequest,
    )

    abstract fun getWorkInfosForUniqueWork(name: String): WorkInfoFuture

    class WorkInfoFuture internal constructor(private val value: List<WorkInfo>) {
        fun get(): List<WorkInfo> = value
    }

    companion object {
        @Volatile
        private var instance: WorkManager? = null

        @JvmStatic
        fun getInstance(context: Context): WorkManager =
            instance ?: synchronized(this) {
                instance ?: LocalWorkManager().also { instance = it }
            }

        @JvmStatic
        fun resetForTest() {
            synchronized(this) { instance = null }
        }
    }
}

private class LocalWorkManager : WorkManager() {
    private val chains = LinkedHashMap<String, MutableList<WorkInfo>>()

    override fun enqueueUniqueWork(name: String, policy: ExistingWorkPolicy, request: OneTimeWorkRequest) {
        val chain = chains.getOrPut(name) { mutableListOf() }
        if (policy == ExistingWorkPolicy.KEEP && chain.isNotEmpty()) return
        chain.add(WorkInfo(request.id, WorkInfo.State.ENQUEUED))
    }

    override fun enqueueUniquePeriodicWork(
        name: String,
        policy: ExistingPeriodicWorkPolicy,
        request: PeriodicWorkRequest,
    ) {
        val chain = chains.getOrPut(name) { mutableListOf() }
        if (policy == ExistingPeriodicWorkPolicy.KEEP && chain.isNotEmpty()) return
        chain.add(WorkInfo(request.id, WorkInfo.State.ENQUEUED))
    }

    override fun getWorkInfosForUniqueWork(name: String): WorkInfoFuture =
        WorkInfoFuture(chains[name]?.toList() ?: emptyList())
}

