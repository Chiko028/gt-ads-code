package gtads.device.state

import android.content.Intent
import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Robolectric-Integrationstest der Energieanbindung (CX-085 / R-904).
 *
 * Simuliert Stromanschluss, Stromverlust und ein unbekanntes Startsignal
 * ueber echte Android-Broadcasts. Playerfreigabe und Display-Nachlauf muessen
 * CX-083 folgen; fehlende Fahrzeugdaten duerfen nie als sicher gelten.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PowerReadinessPlaybackGateTest {

    private var now = 0L

    @Test
    fun powerConnectAndLossDrivePlaybackWhileDisplayEndsAfterGrace() {
        val app = RuntimeEnvironment.getApplication()
        // Unbekanntes Startsignal: kein Stromsignal vorhanden.
        val readiness = PowerConnectionReadinessSource(app, readInitial = { null })
        assertEquals(VehicleReadiness.UNKNOWN, readiness.current())

        val decisions = mutableListOf<GateDecision>()
        val pending = mutableListOf<Pair<Long, () -> Unit>>()
        val coordinator = PlaybackStateCoordinator(
            machine = PlaybackStateMachine(
                config = StateMachineConfig(displayGraceMillis = 120_000L),
                clock = { now },
            ),
            readiness = readiness,
            content = { ContentAvailability.VALID },
            schedule = { delay, action ->
                pending += delay to action
                ScheduledTask { }
            },
            onDecision = { decisions += it },
        )

        coordinator.start()

        // UNKNOWN blockiert Wiedergabe und ist ausdruecklich kein Fahrzeug-aus.
        val unknown = decisions.last()
        assertFalse(unknown.playbackAllowed)
        assertEquals(DecisionReason.VEHICLE_UNKNOWN, unknown.reason)
        assertTrue("Ohne Fahrzeugdaten bleibt das Display benoetigt", unknown.displayRequired)

        // Stromanschluss -> ON, Wiedergabe frei.
        app.sendBroadcast(Intent(Intent.ACTION_POWER_CONNECTED))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(VehicleReadiness.ON, readiness.current())
        val connected = decisions.last()
        assertTrue(connected.playbackAllowed)
        assertEquals(DecisionReason.PLAYING, connected.reason)

        // Stromverlust -> OFF, Wiedergabe sofort gesperrt, Display-Nachlauf laeuft.
        val beforeLoss = decisions.size
        app.sendBroadcast(Intent(Intent.ACTION_POWER_DISCONNECTED))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(VehicleReadiness.OFF, readiness.current())
        val lost = decisions.last()
        assertEquals("genau eine Entscheidung je Uebergang", beforeLoss + 1, decisions.size)
        assertFalse(lost.playbackAllowed)
        assertEquals(DecisionReason.VEHICLE_OFF, lost.reason)
        assertTrue(lost.displayRequired)
        assertEquals(120_000L, pending.last().first)

        // Nach dem Nachlauf endet der Displaybedarf; Wiedergabe bleibt gesperrt.
        now += 120_000L
        pending.last().second()
        val afterGrace = decisions.last()
        assertFalse(afterGrace.displayRequired)
        assertFalse(afterGrace.playbackAllowed)

        // Stop meldet den Beobachter ab: ein weiterer Broadcast veraendert nichts.
        coordinator.stop()
        val decisionsAfterStop = decisions.size
        app.sendBroadcast(Intent(Intent.ACTION_POWER_CONNECTED))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(decisionsAfterStop, decisions.size)
    }
}
