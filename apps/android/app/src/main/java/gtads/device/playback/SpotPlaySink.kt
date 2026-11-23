package gtads.device.playback

import java.time.Instant

/**
 * CX-160 / R-903: Nachweis genau einer beendeten Spotwiedergabe.
 *
 * Die Meldung enthaelt nur, was der Controller selbst sicher weiss: Kampagne
 * und Video aus dem aktivierten Slot, den Wanduhrbeginn, die monoton gemessene
 * gezeigte Dauer und ob der Spot vollstaendig lief. Es gibt keine erfundene
 * Abspiel-ID; die vergibt erst der Puffer (SpotPlayRecorder).
 */
data class SpotPlayRecord(
    val campaignId: String,
    val mediaId: String,
    val startedAt: Instant,
    val playedMs: Long,
    val completed: Boolean,
)

/**
 * Senke fuer beendete Spots. Die Meldung ist best effort: Fehler einer Senke
 * duerfen die Wiedergabe nicht beeinflussen. [NONE] ist der stille Standard
 * fuer Aufrufer ohne Persistenz (z. B. reine Controller-Tests).
 */
fun interface SpotPlaySink {
    fun report(record: SpotPlayRecord)

    companion object {
        val NONE: SpotPlaySink = SpotPlaySink { }
    }
}
