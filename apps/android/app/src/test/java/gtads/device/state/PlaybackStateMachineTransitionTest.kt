package gtads.device.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests fuer Uebergangsdisziplin und Pausenruecksetzung: doppelte Eingaben
 * erzeugen keinen zweiten Uebergang; beide konfigurierbaren Varianten der
 * Pausenruecksetzung bei Fahrzeug-aus funktionieren.
 */
class PlaybackStateMachineTransitionTest {

    private var now = 0L

    private fun machine(config: StateMachineConfig = StateMachineConfig()) =
        PlaybackStateMachine(config = config, clock = { now })

    private fun input(
        vehicle: VehicleReadiness,
        pauseActive: Boolean = false,
    ) = StateInput(
        vehicle = vehicle,
        pauseActive = pauseActive,
        content = ContentAvailability.VALID,
        player = PlayerCondition.OK,
    )

    @Test
    fun duplicateInputsDoNotCreateSecondTransition() {
        val machine = machine()
        val readyInput = input(VehicleReadiness.ON)
        val first = machine.evaluate(readyInput)
        assertEquals(0L, first.transitions)
        repeat(5) {
            assertEquals(first, machine.evaluate(readyInput))
        }

        val pausedInput = input(VehicleReadiness.ON, pauseActive = true)
        val paused = machine.evaluate(pausedInput)
        assertEquals(DecisionReason.PAUSED, paused.reason)
        assertEquals(1L, paused.transitions)
        repeat(5) {
            val duplicate = machine.evaluate(pausedInput)
            assertEquals(paused, duplicate)
            assertEquals(1L, duplicate.transitions)
        }

        now = 1_000L
        val offInput = input(VehicleReadiness.OFF, pauseActive = true)
        val off = machine.evaluate(offInput)
        assertEquals(DecisionReason.VEHICLE_OFF, off.reason)
        assertEquals(2L, off.transitions)
        val offDuplicate = machine.evaluate(offInput)
        assertEquals(off, offDuplicate)
        assertEquals(2L, offDuplicate.transitions)

        now = 1_000L + DEFAULT_DISPLAY_GRACE_MILLIS
        val expired = machine.evaluate(offInput)
        assertFalse(expired.displayRequired)
        assertEquals(3L, expired.transitions)
        val expiredDuplicate = machine.evaluate(offInput)
        assertEquals(expired, expiredDuplicate)
        assertEquals(3L, expiredDuplicate.transitions)
    }

    @Test
    fun pauseSurvivesVehicleOffByDefault() {
        val run = run(resetPauseOnVehicleOff = false)
        assertTrue("Standard: Pause bleibt gespeichert", run.duringOff.pauseEffective)
        assertEquals(DecisionReason.VEHICLE_OFF, run.duringOff.reason)
        assertFalse(run.backOn.playbackAllowed)
        assertTrue(run.backOn.pauseEffective)
        assertEquals(DecisionReason.PAUSED, run.backOn.reason)
    }

    @Test
    fun configurablePauseResetClearsPauseOnVehicleOff() {
        val run = run(resetPauseOnVehicleOff = true)
        assertFalse("Reset: Pause ist bei off aufgehoben", run.duringOff.pauseEffective)
        assertEquals(DecisionReason.VEHICLE_OFF, run.duringOff.reason)
        assertTrue(run.backOn.playbackAllowed)
        assertFalse(run.backOn.pauseEffective)
        assertEquals(DecisionReason.PLAYING, run.backOn.reason)
        assertTrue(run.afterPauseRelease.playbackAllowed)
        assertEquals("eine neue Pausenflanke wirkt wieder", DecisionReason.PAUSED, run.repaused.reason)
        assertTrue(run.repaused.pauseEffective)
    }

    @Test
    fun defaultsMatchSpecifiedBehaviour() {
        val config = StateMachineConfig()
        assertEquals(120_000L, config.displayGraceMillis)
        assertEquals(DEFAULT_DISPLAY_GRACE_MILLIS, config.displayGraceMillis)
        assertFalse("Fernpause wird standardmaessig nicht aufgehoben", config.resetPauseOnVehicleOff)
    }

    private data class ResetRun(
        val duringOff: StateSnapshot,
        val backOn: StateSnapshot,
        val afterPauseRelease: StateSnapshot,
        val repaused: StateSnapshot,
    )

    /**
     * Feste Abfolge: bereit, Pause, Fahrzeug-aus, Nachlauf abgelaufen, wieder
     * bereit (Pauseneingabe unveraendert), Pause freigegeben, erneut pausiert.
     */
    private fun run(resetPauseOnVehicleOff: Boolean): ResetRun {
        now = 0L
        val machine = machine(StateMachineConfig(resetPauseOnVehicleOff = resetPauseOnVehicleOff))
        machine.evaluate(input(VehicleReadiness.ON))
        val paused = machine.evaluate(input(VehicleReadiness.ON, pauseActive = true))
        assertEquals(DecisionReason.PAUSED, paused.reason)

        val duringOff = machine.evaluate(input(VehicleReadiness.OFF, pauseActive = true))
        now = DEFAULT_DISPLAY_GRACE_MILLIS
        val offExpired = machine.evaluate(input(VehicleReadiness.OFF, pauseActive = true))
        assertFalse(offExpired.displayRequired)

        val backOn = machine.evaluate(input(VehicleReadiness.ON, pauseActive = true))
        assertTrue(backOn.displayRequired)
        val afterPauseRelease = machine.evaluate(input(VehicleReadiness.ON, pauseActive = false))
        val repaused = machine.evaluate(input(VehicleReadiness.ON, pauseActive = true))
        return ResetRun(duringOff, backOn, afterPauseRelease, repaused)
    }
}
