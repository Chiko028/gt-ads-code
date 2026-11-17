package gtads.device.playback

import android.app.Activity
import android.view.View
import android.widget.FrameLayout
import androidx.media3.common.Player
import androidx.media3.ui.PlayerView

/**
 * Erzeugt die Media3-PlayerView ohne Bedienelemente (CX-082 / R-903).
 *
 * Bewusst in einer eigenen Datei, damit JVM-/Robolectric-Tests, die nur den
 * Controller und den Player-Port pruefen, die Media3-UI nicht laden muessen.
 * Es werden keine Kiosk-Flags gesetzt; Debug bleibt normal verlassbar.
 */
internal fun createMedia3PlaybackSurface(activity: Activity): View = Media3PlayerSurfaceView(activity)

private class Media3PlayerSurfaceView(activity: Activity) : FrameLayout(activity), PlaybackSurface {
    private val playerView = PlayerView(activity).apply { setUseController(false) }

    init {
        addView(
            playerView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
    }

    override fun bindPlayer(player: Player?) {
        playerView.player = player
    }
}
