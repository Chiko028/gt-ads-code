package androidx.work

import android.content.Context

/**
 * Lokale, API-kompatible WorkManager-Minimalimplementierung fuer die
 * Offline-Testumgebung (der Runner-Cache enthaelt WorkManager 2.9.1 nicht).
 * Nur die von CX-077 genutzten Typen und Semantiken sind vorhanden.
 */
abstract class ListenableWorker(
    val appContext: Context,
    val workerParameters: WorkerParameters,
) {
    val applicationContext: Context get() = appContext

    open val isStopped: Boolean get() = false

    abstract fun doWork(): Result

    abstract class Result {
        class Success : Result()
        class Failure : Result()
        class Retry : Result()

        companion object {
            @JvmStatic
            fun success(): Result = Success()

            @JvmStatic
            fun failure(): Result = Failure()

            @JvmStatic
            fun retry(): Result = Retry()
        }
    }
}

