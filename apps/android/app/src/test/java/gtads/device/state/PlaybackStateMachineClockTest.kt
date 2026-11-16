package gtads.device.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests mit injizierter monotoner Uhr: sofortiger Wiedergabestopp bei
 * Fahrzeug-aus und Displayfreigabe exakt vor und nach dem Nachlauf.
 */
private const val GRACE_MILLIS = 120_000L

class PlaybackStateMachineClockTest {

    private var now = 0L
    private val machine = PlaybackStateMachine(
        config = StateMachineConfig(displayGraceMillis = GRACE_MILLIS),
        clock = { now },
    )

    private fun input(vehicle: VehicleReadiness) = StateInput(
        vehicle = vehicle,
        pauseActive = false,
        content = ContentAvailability.VALID,
        player = PlayerCondition.OK,
    )

    @Test
    fun playbackStopsImmediatelyWhenVehicleTurnsOff() {
        val ready = machine.evaluate(input(VehicleReadiness.ON))
        assertTrue(ready.playbackAllowed)

        now = 1_000L
        val off = machine.evaluate(input(VehicleReadiness.OFF))
        assertFalse("Wiedergabe stoppt mit der Auswertung von off sofort", off.playbackAllowed)
        assertEquals(DecisionReason.VEHICLE_OFF, off.reason)
        assertTrue("Display bleibt im Nachlauf an", off.displayRequired)
    }

    @Test
    fun displayEndsExactlyAfterConfiguredGrace() {
        machine.evaluate(input(VehicleReadiness.ON))
        now = 5_000L
        val off = machine.evaluate(input(VehicleReadiness.OFF))
        assertTrue(off.displayRequired)
        assertEquals(1L, off.transitions)

        now = 5_000L + GRACE_MILLIS - 1L
        val before = machine.evaluate(input(VehicleReadiness.OFF))
        assertTrue("kurz vor dem Nachlauf bleibt das Display an", before.displayRequired)
        assertFalse(before.playbackAllowed)
        assertEquals(1L, before.transitions)

        now = 5_000L + GRACE_MILLIS
        val atDeadline = machine.evaluate(input(VehicleReadiness.OFF))
        assertFalse("mit Erreichen des Nachlaufs endet der Displaybedarf", atDeadline.displayRequired)
        assertEquals(DecisionReason.VEHICLE_OFF, atDeadline.reason)
        assertEquals(2L, atDeadline.transitions)

        now = 5_000L + GRACE_MILLIS + 1L
        val after = machine.evaluate(input(VehicleReadiness.OFF))
        assertFalse("nach dem Nachlauf bleibt das Display aus", after.displayRequired)
        assertFalse(after.playbackAllowed)
        assertEquals(2L, after.transitions)
    }

    @Test
    fun unknownDoesNotStartDisplayGraceAndIsNotVehicleOff() {
        now = 10_000_000L
        val unknown = machine.evaluate(input(VehicleReadiness.UNKNOWN))
        assertFalse(unknown.playbackAllowed)
        assertEquals(DecisionReason.VEHICLE_UNKNOWN, unknown.reason)
        assertNotEquals(DecisionReason.VEHICLE_OFF, unknown.reason)
        assertTrue(unknown.displayRequired)

        now += 10L * GRACE_MILLIS
        val later = machine.evaluate(input(VehicleReadiness.UNKNOWN))
        assertEquals(DecisionReason.VEHICLE_UNKNOWN, later.reason)
        assertTrue("unbekannt wird nicht als Fahrzeug-aus behandelt", later.displayRequired)
        assertEquals(unknown.transitions, later.transitions)
    }

}
