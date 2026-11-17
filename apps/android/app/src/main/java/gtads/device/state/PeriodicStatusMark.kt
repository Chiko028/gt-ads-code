package gtads.device.state

import android.content.Context
import java.time.Instant

/**
 * CX-099: Zeitpunkt des letzten erfolgreich im CX-084-Puffer gespeicherten
 * periodischen Statusberichts. Er wird erst nach erfolgreichem Commit
 * fortgeschrieben.
 */
interface PeriodicStatusMark {
    fun lastStored(): Instant?
    fun markStored(at: Instant)
}

/** Nicht persistente Markierung fuer Tests. */
class InMemoryPeriodicStatusMark(private var value: Instant? = null) : PeriodicStatusMark {
    override fun lastStored(): Instant? = value
    override fun markStored(at: Instant) {
        value = at
    }
}

/** Persistente Markierung in den privaten App-Einstellungen. */
class SharedPreferencesPeriodicStatusMark(context: Context) : PeriodicStatusMark {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun lastStored(): Instant? {
        val millis = preferences.getLong(KEY_LAST, -1L)
        return if (millis < 0L) null else Instant.ofEpochMilli(millis)
    }

    override fun markStored(at: Instant) {
        preferences.edit().putLong(KEY_LAST, at.toEpochMilli()).commit()
    }

    private companion object {
        const val PREFERENCES_NAME = "periodic-status"
        const val KEY_LAST = "last-stored-ms"
    }
}
