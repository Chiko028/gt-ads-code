package gtads.device.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tabellengetriebene Tests fuer CX-083: Fahrzeugbereitschaft, Pause,
 * gueltiger Inhalt und Playerfehler ergeben reproduzierbare Entscheidungen.
 * Netzverlust ist nur ein Statusmerkmal.
 */
class PlaybackStateMachineTableTest {

    private data class Case(
        val name: String,
        val input: StateInput,
        val playbackAllowed: Boolean,
        val displayRequired: Boolean,
        val reason: DecisionReason,
    )

    private fun machine(nowMillis: Long = 0L) = PlaybackStateMachine(
        config = StateMachineConfig(),
        clock = { nowMillis },
    )

    private fun input(
        vehicle: VehicleReadiness,
        pauseActive: Boolean = false,
        content: ContentAvailability = ContentAvailability.VALID,
        player: PlayerCondition = PlayerCondition.OK,
        network: NetworkStatus = NetworkStatus.AVAILABLE,
    ) = StateInput(vehicle, pauseActive, content, player, network)

    @Test
    fun tableDrivenInputsProduceReproducibleDecisions() {
        val cases = listOf(
            Case("bereit, spielbar", input(VehicleReadiness.ON), true, true, DecisionReason.PLAYING),
            Case(
                "bereit, offline",
                input(VehicleReadiness.ON, network = NetworkStatus.UNAVAILABLE),
                true,
                true,
                DecisionReason.PLAYING,
            ),
            Case(
                "bereit, pausiert",
                input(VehicleReadiness.ON, pauseActive = true),
                false,
                true,
                DecisionReason.PAUSED,
            ),
            Case(
                "bereit, kein Inhalt",
                input(VehicleReadiness.ON, content = ContentAvailability.NONE),
                false,
                true,
                DecisionReason.NO_VALID_CONTENT,
            ),
            Case(
                "bereit, Playerfehler",
                input(VehicleReadiness.ON, player = PlayerCondition.ERROR),
                false,
                true,
                DecisionReason.PLAYER_ERROR,
            ),
            Case(
                "unbekannt",
                input(VehicleReadiness.UNKNOWN),
                false,
                true,
                DecisionReason.VEHICLE_UNKNOWN,
            ),
            Case(
                "unbekannt, offline",
                input(VehicleReadiness.UNKNOWN, network = NetworkStatus.UNAVAILABLE),
                false,
                true,
                DecisionReason.VEHICLE_UNKNOWN,
            ),
            Case("fahrzeug aus", input(VehicleReadiness.OFF), false, true, DecisionReason.VEHICLE_OFF),
        )

        for (case in cases) {
            val first = machine().evaluate(case.input)
            val second = machine().evaluate(case.input)
            assertEquals(case.name + ": playbackAllowed", case.playbackAllowed, first.playbackAllowed)
            assertEquals(case.name + ": displayRequired", case.displayRequired, first.displayRequired)
            assertEquals(case.name + ": reason", case.reason, first.reason)
            assertEquals(case.name + ": reproduzierbar", first, second)
            if (case.playbackAllowed) {
                assertTrue(case.name + ": Wiedergabe nur mit Bereitschaft ON", case.input.vehicle == VehicleReadiness.ON)
                assertFalse(case.name + ": keine Pause", case.input.pauseActive)
                assertEquals(case.name + ": gueltiger Inhalt", ContentAvailability.VALID, case.input.content)
                assertEquals(case.name + ": kein Playerfehler", PlayerCondition.OK, case.input.player)
            }
        }
    }

    @Test
    fun unknownReadinessIsNotClassifiedAsVehicleOff() {
        val snapshot = machine().evaluate(input(VehicleReadiness.UNKNOWN))
        assertEquals(DecisionReason.VEHICLE_UNKNOWN, snapshot.reason)
        assertNotEquals(DecisionReason.VEHICLE_OFF, snapshot.reason)
        assertFalse(snapshot.playbackAllowed)
    }

    @Test
    fun networkLossAloneDoesNotStopValidOfflinePlayback() {
        var now = 0L
        val machine = PlaybackStateMachine(
            config = StateMachineConfig(),
            clock = { now },
        )
        val online = machine.evaluate(input(VehicleReadiness.ON))
        assertTrue(online.playbackAllowed)
        assertEquals(DecisionReason.PLAYING, online.reason)

        now = 1_000L
        val offline = machine.evaluate(input(VehicleReadiness.ON, network = NetworkStatus.UNAVAILABLE))
        assertTrue("Netzverlust allein stoppt gueltige Offline-Wiedergabe nicht", offline.playbackAllowed)
        assertEquals(DecisionReason.PLAYING, offline.reason)
        assertTrue(offline.displayRequired)
        assertEquals(online.transitions, offline.transitions)
        assertEquals(NetworkStatus.UNAVAILABLE, offline.network)
    }
}
