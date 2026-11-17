// Frueher lag hier eine lokale Nachbildung von androidx.work.testing.TestListenableWorkerBuilder.
// Seit der Umstellung auf die echte WorkManager-Bibliothek 2.9.1 (work-testing) stammt diese
// Klasse aus der Bibliothek; die Datei enthaelt nur noch die gemeinsame Testinitialisierung.
package gtads.device.testsupport

import android.content.Context
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper

/** Initialisiert je Test eine echte WorkManager-Testinstanz mit synchronem Executor. */
fun initializeTestWorkManager(context: Context) {
    WorkManagerTestInitHelper.initializeTestWorkManager(
        context,
        Configuration.Builder().setExecutor(SynchronousExecutor()).build(),
    )
}
