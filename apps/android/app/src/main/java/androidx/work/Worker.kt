package androidx.work

import android.content.Context

abstract class Worker(
    appContext: Context,
    workerParameters: WorkerParameters,
) : ListenableWorker(appContext, workerParameters)

