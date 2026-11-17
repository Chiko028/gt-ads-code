package androidx.work.testing

import android.content.Context
import androidx.work.ListenableWorker
import androidx.work.WorkerParameters

/** Lokaler WorkManager-Testbaustein fuer die Offline-Testumgebung. */
class TestListenableWorkerBuilder<W : ListenableWorker>(
    private val context: Context,
    private val workerClass: Class<W>,
) {
    @Suppress("UNCHECKED_CAST")
    fun build(): W {
        val constructor = workerClass.getConstructor(Context::class.java, WorkerParameters::class.java)
        return constructor.newInstance(context, WorkerParameters()) as W
    }
}

