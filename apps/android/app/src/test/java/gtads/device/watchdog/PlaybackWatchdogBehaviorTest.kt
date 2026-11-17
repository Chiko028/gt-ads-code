package gtads.device.watchdog

import gtads.device.location.GpsMode
import gtads.device.location.NullGpsProvider
import gtads.device.manifest.ManifestSlot
import gtads.device.manifest.VerifiedMedia
import gtads.device.playback.PlaybackDecision
import gtads.device.presence.NullPassengerPresenceProvider
import gtads.device.presence.PresenceReading
import gtads.device.state.DecisionReason
import gtads.device.state.NetworkStatus
import gtads.device.state.StateSnapshot
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Ausfuehrbare Verhaltenstests fuer CX-088 / R-906.
 *
 * Alle Fristen laufen ueber eine injizierte monotone Uhr. Es gibt keine
 * Sleeps, keinen echten Player und keinen Netzzugriff.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackWatchdogBehaviorTest {

    private var now = 0L

    private val media = VerifiedMedia.of("SYN-watchdog", "a".repeat(64), 1_000L)!!
    private val slot = ManifestSlot(
        0,
        media,
        60_000L,
        "SYN-campaign",
        Instant.parse("2026-12-01T10:00:00Z"),
        Instant.parse("2026-12-01T11:00:00Z"),
    )
    private val playable = PlaybackDecision.Play(slot, slot.endAt)

    private val playing = StateSnapshot(
        playbackAllowed = true,
        displayRequired = true,
        reason = DecisionReason.PLAYING,
        pauseEffective = false,
        network = NetworkStatus.AVAILABLE,
        transitions = 0L,
    )
    private val paused = playing.copy(
        playbackAllowed = false,
        reason = DecisionReason.PAUSED,
        pauseEffective = true,
    )
    private val vehicleOff = playing.copy(
        playbackAllowed = false,
        reason = DecisionReason.VEHICLE_OFF,
        pauseEffective = false,
    )

    private val progress = PlaybackProgress(generation = 1L, positionMillis = 0L)

    private fun watchdog(
        recovery: PlaybackRecovery,
        config: WatchdogConfig = WatchdogConfig(),
    ): PlaybackWatchdog = PlaybackWatchdog(
        recovery = recovery,
        config = config,
        clock = { now },
    )

    private class RecordingRecovery(
        private val result: RecoveryResult = RecoveryResult.Recovered,
    ) : PlaybackRecovery {
        val calls = AtomicInteger(0)

        override fun recover(): RecoveryResult {
            calls.incrementAndGet()
            return result
        }
    }

    private class BlockingRecovery : PlaybackRecovery {
        val calls = AtomicInteger(0)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)

        override fun recover(): RecoveryResult {
            calls.incrementAndGet()
            entered.countDown()
            release.await(5, TimeUnit.SECONDS)
            return RecoveryResult.Recovered
        }
    }

    @Test
    fun progressPreventsRecoveryAndMissingProgressTriggersExactlyOneAttemptAfterTimeout() {
        val recovery = RecordingRecovery()
        val guard = watchdog(recovery)

        now = 0L
        assertEquals(WatchdogStatus.PROGRESS, guard.check(playing, playable, progress).status)

        now = 30_000L
        val advanced = progress.copy(positionMillis = 15_000L)
        assertEquals(
            WatchdogStatus.PROGRESS,
            guard.check(playing, playable, advanced).status,
        )
        assertEquals(
            "laufender Fortschritt darf keine Wiederherstellung ausloesen",
            0,
            recovery.calls.get(),
        )

        now = 89_999L
        assertEquals(
            WatchdogStatus.WAITING,
            guard.check(playing, playable, advanced).status,
        )
        assertEquals(0, recovery.calls.get())

        now = 90_000L
        val due = guard.check(playing, playable, advanced)
        assertEquals(WatchdogStatus.RECOVERED, due.status)
        assertEquals(1, due.attemptsInWindow)
        assertEquals(1L, (due.attemptNumber ?: -1).toLong())
        assertEquals("genau ein Versuch nach der Frist", 1, recovery.calls.get())

        now = 90_001L
        assertEquals(
            WatchdogStatus.ATTEMPT_THROTTLED,
            guard.check(playing, playable, advanced).status,
        )
        assertEquals("kein zweiter Versuch innerhalb der Mindestpause", 1, recovery.calls.get())
    }

    @Test
    fun pauseVehicleOffAndMissingPlanningNeverRecoverAndResumeNeedsFullTimeout() {
        val recovery = RecordingRecovery()
        val guard = watchdog(recovery)

        now = 0L
        assertEquals(WatchdogStatus.PROGRESS, guard.check(playing, playable, progress).status)

        now = 61_000L
        assertEquals(WatchdogStatus.INACTIVE, guard.check(paused, playable, progress).status)

        now = 10L * 60_000L
        assertEquals(WatchdogStatus.INACTIVE, guard.check(paused, playable, progress).status)

        now = 20L * 60_000L
        assertEquals(
            WatchdogStatus.INACTIVE,
            guard.check(vehicleOff, playable, progress).status,
        )

        now = 30L * 60_000L
        assertEquals(
            WatchdogStatus.INACTIVE,
            guard.check(playing, PlaybackDecision.Empty, progress).status,
        )
        assertEquals(
            "Pause, Fahrzeug-aus und fehlende Planung loesen keinen Versuch aus",
            0,
            recovery.calls.get(),
        )

        // Nach der Unterbrechung beginnt die Frist vollstaendig neu.
        now = 40L * 60_000L
        assertEquals(WatchdogStatus.PROGRESS, guard.check(playing, playable, progress).status)
        now = 40L * 60_000L + 59_999L
        assertEquals(WatchdogStatus.WAITING, guard.check(playing, playable, progress).status)
        assertEquals(0, recovery.calls.get())

        now = 40L * 60_000L + 60_000L
        val due = guard.check(playing, playable, progress)
        assertEquals(WatchdogStatus.RECOVERED, due.status)
        assertEquals(1L, (due.attemptNumber ?: -1).toLong())
        assertEquals(1, recovery.calls.get())
    }

    @Test
    fun repeatedFailuresRespectAttemptLimitHealthyResetAndSerialization() {
        // Standardfenster: hoechstens drei Versuche innerhalb von zehn Minuten.
        val failing = RecordingRecovery(
            RecoveryResult.Failed(RecoveryFailureCode.PLAYER_UNAVAILABLE),
        )
        val defaultWatchdog = watchdog(failing)

        now = 0L
        assertEquals(WatchdogStatus.PROGRESS, defaultWatchdog.check(playing, playable, progress).status)
        now = 60_000L
        assertEquals(
            WatchdogStatus.RECOVERY_FAILED,
            defaultWatchdog.check(playing, playable, progress).status,
        )
        now = 90_000L
        assertEquals(
            WatchdogStatus.RECOVERY_FAILED,
            defaultWatchdog.check(playing, playable, progress).status,
        )
        now = 120_000L
        assertEquals(
            WatchdogStatus.RECOVERY_FAILED,
            defaultWatchdog.check(playing, playable, progress).status,
        )
        now = 150_000L
        val limited = defaultWatchdog.check(playing, playable, progress)
        assertEquals(WatchdogStatus.ATTEMPT_LIMIT_REACHED, limited.status)
        assertEquals(3, limited.attemptsInWindow)
        assertEquals("Obergrenze darf nicht ueberschritten werden", 3, failing.calls.get())

        // Eigenes, laengeres Versuchsfenster macht die gesunde Ruecksetzung
        // unabhaengig von der Fensterbereinigung pruefbar.
        val resetRecovery = RecordingRecovery(
            RecoveryResult.Failed(RecoveryFailureCode.PLAYER_UNAVAILABLE),
        )
        val resetWatchdog = watchdog(
            resetRecovery,
            WatchdogConfig(attemptWindowMillis = 60L * 60_000L),
        )
        now = 0L
        assertEquals(WatchdogStatus.PROGRESS, resetWatchdog.check(playing, playable, progress).status)
        now = 60_000L
        assertEquals(
            WatchdogStatus.RECOVERY_FAILED,
            resetWatchdog.check(playing, playable, progress).status,
        )
        now = 90_000L
        assertEquals(
            WatchdogStatus.RECOVERY_FAILED,
            resetWatchdog.check(playing, playable, progress).status,
        )
        now = 120_000L
        assertEquals(
            WatchdogStatus.RECOVERY_FAILED,
            resetWatchdog.check(playing, playable, progress).status,
        )
        now = 150_000L
        assertEquals(
            WatchdogStatus.ATTEMPT_LIMIT_REACHED,
            resetWatchdog.check(playing, playable, progress).status,
        )

        // Zehn Minuten nachgewiesen gesunder Betrieb setzen den Zaehler zurueck.
        var position = 1_000L
        now = 150_001L
        assertEquals(
            WatchdogStatus.PROGRESS,
            resetWatchdog.check(
                playing,
                playable,
                PlaybackProgress(generation = 1L, positionMillis = position),
            ).status,
        )
        var elapsed = 150_001L
        var lastOutcome: WatchdogOutcome? = null
        while (elapsed < 750_001L) {
            elapsed += 30_000L
            now = elapsed
            position += 500L
            val outcome = resetWatchdog.check(
                playing,
                playable,
                PlaybackProgress(generation = 1L, positionMillis = position),
            )
            lastOutcome = outcome
            assertEquals(WatchdogStatus.PROGRESS, outcome.status)
        }
        assertEquals(
            "nach zehn Minuten gesundem Betrieb ist der Zaehler zurueckgesetzt",
            0,
            lastOutcome!!.attemptsInWindow,
        )

        now = 810_001L
        val afterReset = resetWatchdog.check(
            playing,
            playable,
            PlaybackProgress(generation = 1L, positionMillis = position),
        )
        assertEquals(WatchdogStatus.RECOVERY_FAILED, afterReset.status)
        assertEquals("neuer Versuch nach der Ruecksetzung", 4, resetRecovery.calls.get())

        // Parallele Pruefungen starten keinen zweiten laufenden Versuch.
        val blocking = BlockingRecovery()
        val concurrentWatchdog = watchdog(blocking)
        now = 2_000_000L
        assertEquals(
            WatchdogStatus.PROGRESS,
            concurrentWatchdog.check(playing, playable, progress).status,
        )
        now = 2_060_000L
        val firstResult = AtomicReference<WatchdogOutcome>()
        val workerFailure = AtomicReference<Throwable>()
        val worker = Thread {
            try {
                firstResult.set(concurrentWatchdog.check(playing, playable, progress))
            } catch (failure: Throwable) {
                workerFailure.set(failure)
            }
        }
        worker.start()
        assertTrue(
            "der erste Versuch muss laufen",
            blocking.entered.await(5, TimeUnit.SECONDS),
        )
        val concurrent = concurrentWatchdog.check(playing, playable, progress)
        assertEquals(WatchdogStatus.ATTEMPT_RUNNING, concurrent.status)
        assertEquals("kein zweiter laufender Versuch", 1, blocking.calls.get())

        blocking.release.countDown()
        worker.join(5_000L)
        assertNull(workerFailure.get())
        assertEquals(WatchdogStatus.RECOVERED, firstResult.get()?.status)
        assertEquals(1, blocking.calls.get())
    }

    @Test
    fun gpsAndPresenceNullAdaptersExposeOnlyUnavailableWithoutSensorOrPermissionUse() {
        val presence = NullPassengerPresenceProvider()
        repeat(100) {
            assertEquals(PresenceReading.UNAVAILABLE, presence.read())
            assertEquals(PresenceReading.UNAVAILABLE, presence.read(remoteRuleEnabled = true))
        }

        val gps = NullGpsProvider()
        for (remoteMode in listOf(null, "", "aus", "lokal_gebiet", "uebermittlung", "unbekannt")) {
            assertEquals(
                "Fernkonfiguration darf GPS nie aktivieren",
                GpsMode.OFF,
                gps.mode(remoteMode),
            )
            assertNull("Nulladapter liefert keine Standortdaten", gps.lastFix())
        }
    }
}
