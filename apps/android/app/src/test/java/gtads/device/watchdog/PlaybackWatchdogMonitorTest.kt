package gtads.device.watchdog

import android.view.View
import gtads.device.playback.FakePlaybackTimer
import gtads.device.playback.LocalMediaPlayerAdapter
import gtads.device.playback.LocalPlayerPort
import gtads.device.playback.MutableClock
import gtads.device.playback.PlaybackController
import gtads.device.playback.manifestSlot
import gtads.device.playback.mediaFixture
import gtads.device.playback.snapshotOf
import gtads.device.state.ContentAvailability
import gtads.device.state.PlaybackStateMachine
import gtads.device.state.PlayerCondition
import gtads.device.state.StateInput
import gtads.device.state.StateSnapshot
import gtads.device.state.VehicleReadiness
import java.io.File
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** CX-089: Watchdog am produktiven Wiedergabelebenszyklus mit synthetischem Player und kontrollierter Zeit. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackWatchdogMonitorTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private var mono = 0L
    private val start = Instant.parse("2026-12-01T10:00:00Z")

    /** Synthetischer Player-Port mit steuerbarer Position. */
    private class ProgressPort : LocalPlayerPort {
        var position = 0L
        var prepares = 0
        var plays = 0
        var releases = 0
        var onRelease: () -> Unit = {}
        override fun setCallbacks(callbacks: LocalPlayerPort.Callbacks?) {}
        override fun disableAudio() {}
        override fun prepare(file: File, generation: Long) {
            prepares++
        }
        override fun play() {
            plays++
        }
        override fun stop() {}
        override fun release() {
            releases++
            onRelease()
        }
        override fun attachView(view: View?) {}
        override fun currentPositionMs(): Long = position
    }

    /** Geplante Termine des Monitors; [fire] loest den aktiven aus. */
    private class Scheduler {
        val active = ArrayList<() -> Unit>()
        var scheduled = 0
        fun schedule(delay: Long, action: () -> Unit): AutoCloseable {
            scheduled++
            active += action
            return AutoCloseable { active.remove(action) }
        }
        fun fire() {
            val next = active.removeAt(0)
            next()
        }
    }

    private class Rig(
        val monitor: PlaybackWatchdogMonitor,
        val controller: PlaybackController,
        val port: ProgressPort,
        val scheduler: Scheduler,
        val faults: MutableList<Boolean>,
        val mediaFile: File,
        val permitted: BooleanArray,
    )

    private fun playing(): StateSnapshot =
        PlaybackStateMachine(clock = { mono }).evaluate(
            StateInput(VehicleReadiness.ON, pauseActive = false, content = ContentAvailability.VALID, player = PlayerCondition.OK),
        )

    private fun rig(): Rig {
        val directory = temporary.newFolder()
        val media = mediaFixture(directory, byteArrayOf(9, 8, 7))
        val manifest = snapshotOf(listOf(manifestSlot(0, media, 3_600_000L, start, start.plusSeconds(7_200))))
        val port = ProgressPort()
        val permitted = booleanArrayOf(true)
        val controller = PlaybackController(
            adapterFactory = { observer -> LocalMediaPlayerAdapter(directory, port, observer) },
            clock = MutableClock(start.plusSeconds(5)),
            snapshots = { manifest },
            timer = FakePlaybackTimer(),
            monotonicMillis = { mono },
            playbackPermitted = { permitted[0] },
        )
        val scheduler = Scheduler()
        val faults = mutableListOf<Boolean>()
        val monitor = PlaybackWatchdogMonitor(
            controller = controller,
            state = { playing() },
            watchdog = PlaybackWatchdog(ControllerPlaybackRecovery(controller), clock = { mono }),
            schedule = scheduler::schedule,
            onFault = { faults += it },
        )
        return Rig(monitor, controller, port, scheduler, faults, File(directory, "media-${media.sha256}.bin"), permitted)
    }

    private fun advance(r: Rig, ticks: Int) {
        repeat(ticks) {
            mono += PlaybackWatchdogMonitor.DEFAULT_INTERVAL_MS
            r.scheduler.fire()
        }
    }

    @Test
    fun stuckPlayerIsReleasedOnceAndRebuiltWithStillValidPlanning() {
        val r = rig()
        r.controller.start()
        r.monitor.start()
        assertEquals(1, r.port.prepares)

        // Position bleibt stehen: nach 60 s genau ein Versuch.
        advance(r, 1)
        advance(r, 6)
        assertEquals(1, r.port.releases)
        assertEquals(2, r.port.prepares)
        assertEquals(2, r.port.plays)
        assertEquals(WatchdogStatus.RECOVERED, r.monitor.lastOutcome?.status)

        // Danach Fortschritt: kein weiterer Versuch.
        repeat(6) {
            r.port.position += 10_000L
            advance(r, 1)
        }
        assertEquals(1, r.port.releases)
    }

    @Test
    fun pauseArrivingDuringRecoveryPreventsPlaybackStart() {
        val r = rig()
        r.controller.start()
        r.monitor.start()
        // Pause trifft genau zwischen Freigabe und Neustart ein.
        r.port.onRelease = { r.permitted[0] = false }
        advance(r, 7)
        assertEquals(1, r.port.releases)
        assertEquals(1, r.port.plays)
        assertEquals(1, r.port.prepares)
    }

    @Test
    fun repeatedStartStopLeavesExactlyOneMonitorAndNoTimerAfterStop() {
        val r = rig()
        r.controller.start()
        repeat(3) { r.monitor.start() }
        assertEquals(1, r.scheduler.active.size)
        r.monitor.stop()
        r.monitor.start()
        r.monitor.start()
        assertEquals(1, r.scheduler.active.size)
        advance(r, 1)
        assertEquals(1, r.scheduler.active.size)
        r.monitor.stop()
        r.monitor.stop()
        assertEquals(0, r.scheduler.active.size)
        assertFalse(r.monitor.hasScheduledCheck())
    }

    @Test
    fun exhaustedBudgetKeepsFaultVisibleWithoutDeletingMediaOrInventingPlayback() {
        val r = rig()
        r.controller.start()
        r.monitor.start()
        // Player bleibt dauerhaft haengen: Versuche bis zur Obergrenze, dann sichtbar gesperrt.
        advance(r, 7)
        repeat(3) { advance(r, 6) }
        advance(r, 12)
        assertEquals(WatchdogStatus.ATTEMPT_LIMIT_REACHED, r.monitor.lastOutcome?.status)
        assertEquals(listOf(true), r.faults)
        assertEquals(3, r.port.releases)
        assertTrue("Medium bleibt erhalten", r.mediaFile.isFile)
        // Keine erfundene Wiedergabe: die Anzahl der Starts entspricht genau Start + Versuchen.
        assertEquals(1 + 3, r.port.plays)
    }
}
