package gtads.device.playback

import gtads.device.manifest.ActiveManifest
import gtads.device.manifest.ManifestSlot
import java.time.Clock
import java.time.Instant

/** Ergebnis der lokalen Planung (CX-080 / R-903). */
sealed interface PlaybackDecision {
    /** Naechster zulaessiger Slot; die Wiedergabe endet spaetestens bei [stopAt]. */
    class Play(val slot: ManifestSlot, val stopAt: Instant) : PlaybackDecision {
        val position: Int get() = slot.position
    }

    /** Kein Slot ist jetzt zulaessig; es wird kein Ersatzspot erfunden. */
    data object Empty : PlaybackDecision
}

/**
 * Bestimmt deterministisch den naechsten zulaessigen Slot aus dem aktivierten
 * Manifest (CX-076). Die Suche beginnt hinter [previousPosition] in
 * Manifestreihenfolge, springt am Ende an den Anfang zurueck und betrachtet
 * jeden Slot hoechstens einmal. Zulaessig ist ein Slot mit
 * `startAt <= nowUtc < endAt`; die Endgrenze ist das Minimum aus Spotdauer
 * und Kampagnenende. Ohne Zustand: jeder Aufruf bewertet die Zeit neu.
 */
fun planNextSlot(snapshot: ActiveManifest, nowUtc: Instant, previousPosition: Int?): PlaybackDecision {
    val slots = snapshot.slots
    val count = slots.size
    if (count == 0) return PlaybackDecision.Empty
    val first = if (previousPosition == null || previousPosition !in 0 until count) 0 else (previousPosition + 1) % count
    for (step in 0 until count) {
        val slot = slots[(first + step) % count]
        if (!slotPlayableAt(slot, nowUtc)) continue
        val spotEnd = saturatingPlus(nowUtc, slot.durationMs)
        val stopAt = if (spotEnd.isBefore(slot.endAt)) spotEnd else slot.endAt
        return PlaybackDecision.Play(slot, stopAt)
    }
    return PlaybackDecision.Empty
}

/**
 * Einzige Laufzeitberechtigung eines Slots (`startAt <= nowUtc < endAt`). REV-195: Planung und
 * Neubewertung eines laufenden Spots verwenden dieselbe Regel; keine zweite Fensterpruefung.
 */
fun slotPlayableAt(slot: ManifestSlot, nowUtc: Instant): Boolean =
    !nowUtc.isBefore(slot.startAt) && nowUtc.isBefore(slot.endAt)

/** Planer mit injizierbarer Uhr; liest die Zeit bei jedem Aufruf neu (Zeitspruenge). */
class PlaybackPlanner(private val clock: Clock = Clock.systemUTC()) {
    fun next(snapshot: ActiveManifest, previousPosition: Int?): PlaybackDecision =
        planNextSlot(snapshot, clock.instant(), previousPosition)

    /** REV-195: Ist der Slot nach der aktuellen Uhr (auch nach Zeit-/Zeitzonenwechseln) noch zulaessig? */
    fun isPlayable(slot: ManifestSlot): Boolean = slotPlayableAt(slot, clock.instant())
}

private fun saturatingPlus(instant: Instant, millis: Long): Instant = try {
    instant.plusMillis(millis)
} catch (_: ArithmeticException) {
    Instant.MAX
} catch (_: java.time.DateTimeException) {
    Instant.MAX
}
