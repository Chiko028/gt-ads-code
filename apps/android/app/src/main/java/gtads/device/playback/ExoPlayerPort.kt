package gtads.device.playback

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import java.io.File

/**
 * Produktionsport des lokalen Playeradapters (CX-081).
 *
 * Es existiert hoechstens ein ExoPlayer. Er wird ausschliesslich auf dem
 * Main-Thread erzeugt, bedient und freigegeben; Aufrufe von anderen Threads
 * werden dorthin umgehaengt. Audio ist immer deaktiviert: Lautstaerke null und
 * Audiotracks ausgeschaltet. Nur lokale Dateien werden als MediaItem gesetzt,
 * niemals HTTP- oder Content-URIs.
 */
internal class ExoPlayerPort(context: Context) : LocalPlayerPort {
    private val appContext: Context = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var callbacks: LocalPlayerPort.Callbacks? = null

    private var player: ExoPlayer? = null
    private var generation = 0L
    private var released = false

    override fun setCallbacks(callbacks: LocalPlayerPort.Callbacks?) {
        this.callbacks = callbacks
    }

    override fun disableAudio() = onMainThread {
        player?.let { applyAudioDisabled(it) }
    }

    override fun prepare(file: File, generation: Long) = onMainThread {
        if (released) return@onMainThread
        releasePlayer()
        this.generation = generation
        val exoPlayer = ExoPlayer.Builder(appContext).build()
        applyAudioDisabled(exoPlayer)
        exoPlayer.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED && this@ExoPlayerPort.generation == generation) {
                    callbacks?.onEnded(generation)
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (this@ExoPlayerPort.generation == generation) {
                    callbacks?.onError(generation, PlaybackRejection.PLAYER_ERROR)
                }
            }
        })
        exoPlayer.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
        exoPlayer.prepare()
        player = exoPlayer
    }

    override fun play() = onMainThread {
        player?.play()
    }

    override fun stop() = onMainThread {
        player?.stop()
    }

    override fun release() = onMainThread {
        if (released) return@onMainThread
        released = true
        // Alte Listener duerfen nach der Freigabe keine Generation mehr treffen.
        generation++
        releasePlayer()
    }

    private fun applyAudioDisabled(exoPlayer: ExoPlayer) {
        exoPlayer.volume = 0f
        exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
            .buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
            .build()
    }

    private fun releasePlayer() {
        player?.release()
        player = null
    }

    private fun onMainThread(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
        } else {
            mainHandler.post(block)
        }
    }
}

