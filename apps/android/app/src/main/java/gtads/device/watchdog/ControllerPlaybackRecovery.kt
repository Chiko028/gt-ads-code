package gtads.device.watchdog

import gtads.device.playback.PlaybackController

/**
 * Produktiver Wiederherstellungsadapter fuer die bestehende Wiedergabeschleife.
 *
 * Es wird keine zweite Player- oder Zustandsimplementierung erzeugt: der
 * Adapter stoppt und startet ausschliesslich den vorhandenen
 * [PlaybackController]. Fehler werden als bereinigter Code zurueckgegeben.
 */
class ControllerPlaybackRecovery(
    private val controller: PlaybackController,
) : PlaybackRecovery {
    override fun recover(): RecoveryResult = try {
        controller.stop()
        controller.start()
        RecoveryResult.Recovered
    } catch (_: Exception) {
        RecoveryResult.Failed(RecoveryFailureCode.PLAYBACK_RESTART_FAILED)
    }
}
