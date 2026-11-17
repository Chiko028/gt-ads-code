package gtads.device.playback

import android.content.Context
import android.view.View
import gtads.device.download.MediaDownloader
import gtads.device.manifest.ActiveManifest
import gtads.device.manifest.VerifiedMedia
import java.io.File

/** Feste, nutzdatenfreie Gruende, warum keine Wiedergabe beginnt. */
enum class PlaybackRejection {
    /** Kein lokaler Dateipfad, sondern eine URI oder ein leerer Wert. */
    UNSUPPORTED_SOURCE,

    /** Der kanonische Pfad liegt nicht in der privaten Medienablage. */
    OUTSIDE_MEDIA_DIRECTORY,

    /** Im erlaubten Verzeichnis existiert keine regulaere Datei. */
    NOT_A_FILE,

    /** Das Medium oder der Slot gehoert nicht zum aktiven Schnappschuss. */
    NOT_ACTIVATED,

    /** Es wurde nichts erfolgreich vorbereitet. */
    NOT_PREPARED,

    /** Der Adapter wurde bereits freigegeben. */
    RELEASED,

    /** Der Player-Port hat einen Fehler gemeldet. */
    PLAYER_ERROR,
}

/** Ergebnis einer Vorbereitung; nur [Prepared] erlaubt einen spaeteren Start. */
sealed interface PrepareResult {
    data class Prepared(val generation: Long) : PrepareResult
    data class Rejected(val reason: PlaybackRejection) : PrepareResult
}

/** Ergebnis eines Startversuchs. */
sealed interface PlaybackStart {
    data class Started(val generation: Long) : PlaybackStart
    data class Rejected(val reason: PlaybackRejection) : PlaybackStart
}

/** Begrenzte typisierte Rueckmeldungen des Adapters. */
sealed interface PlaybackEvent {
    data class Started(val generation: Long) : PlaybackEvent
    data class Ended(val generation: Long) : PlaybackEvent
    data class Failed(val generation: Long, val reason: PlaybackRejection) : PlaybackEvent
}

fun interface PlaybackObserver {
    fun onEvent(event: PlaybackEvent)
}

/**
 * Kleiner injizierbarer Port um Media3. Die Produktionsimplementierung
 * [ExoPlayerPort] verwaltet genau einen ExoPlayer auf dem Main-Thread.
 * Der Adapter ruft alle Methoden auf dem Main-Thread auf.
 */
interface LocalPlayerPort {
    fun setCallbacks(callbacks: Callbacks?)

    /** Deaktiviert Audiotracks und setzt die Lautstaerke auf null. */
    fun disableAudio()

    /** Bereitet ausschliesslich eine bereits validierte lokale Datei vor. */
    fun prepare(file: File, generation: Long)

    fun play()
    fun stop()
    fun release()

    /** Bindet optional eine Ansicht an den Player; Standard ist keine Oberflaeche. */
    fun attachView(view: View?) {}

    /** CX-089: aktuelle Wiedergabeposition in ms oder -1, wenn unbekannt. */
    fun currentPositionMs(): Long = -1L

    interface Callbacks {
        fun onEnded(generation: Long)
        fun onError(generation: Long, reason: PlaybackRejection)
    }
}

/**
 * Lokaler Media3-Playeradapter (CX-081 / R-903).
 *
 * Der Adapter kennt nur bereits freigegebene Medien aus dem lokalen
 * Manifest-/Snapshotmodell (CX-076) und leitet den Dateinamen selbst aus dem
 * SHA-256 ab. Ein Aufrufer kann keinen Manifestpfad oder eine URI
 * durchreichen: Zeichenkettenquellen werden kanonisch geprueft und muessen
 * innerhalb der privaten Medienablage auf eine vorhandene regulaere Datei
 * zeigen. Es gibt keine Schleifensteuerung, Activity-Integration, keinen
 * Foreground-Service, keine Telemetrie und keine Fallbacks.
 *
 * Jede Vorbereitung erhoeht die Generation. Callbacks des Ports tragen die
 * Generation ihrer Wiedergabe; nach einem Austausch, Stoppen oder Freigeben
 * werden verspaetete Callbacks verworfen. [stop] und [release] sind idempotent.
 */
class LocalMediaPlayerAdapter internal constructor(
    private val mediaDirectory: File,
    private val port: LocalPlayerPort,
    private val observer: PlaybackObserver? = null,
) {
    /** Produktive Verdrahtung: private Medienablage aus CX-075/CX-076. */
    constructor(context: Context) : this(context, null)

    /** Produktive Verdrahtung mit optionalem Beobachter fuer die Activity-Schleife. */
    internal constructor(context: Context, observer: PlaybackObserver?) : this(
        File(context.filesDir, MediaDownloader.MEDIA_DIRECTORY),
        ExoPlayerPort(context.applicationContext),
        observer,
    )

    private enum class State { IDLE, PREPARED, PLAYING, RELEASED }

    /** CX-089: Generation und Position der laufenden Wiedergabe, sonst null. */
    fun progress(): Pair<Long, Long>? = synchronized(lock) {
        if (state != State.PLAYING) return@synchronized null
        generation to port.currentPositionMs()
    }

    private val lock = Any()
    private var state = State.IDLE
    private var generation = 0L

    init {
        port.setCallbacks(object : LocalPlayerPort.Callbacks {
            override fun onEnded(generation: Long) = handleEnded(generation)

            override fun onError(generation: Long, reason: PlaybackRejection) = handleError(generation, reason)
        })
    }

    /**
     * Bereitet ausschliesslich den von CX-080 ausgewaehlten Slot vor, sofern
     * dessen Medium im aktiven Schnappschuss (CX-076) enthalten ist. Die
     * Zeitsteuerung bleibt beim Aufrufer.
     */
    fun prepare(snapshot: ActiveManifest, decision: PlaybackDecision.Play): PrepareResult {
        val media = decision.slot.media
        val activated = snapshot.media.any {
            it.mediaId == media.mediaId && it.sha256 == media.sha256
        }
        val slotPresent = snapshot.slots.any {
            it.position == decision.slot.position &&
                it.media.mediaId == media.mediaId &&
                it.media.sha256 == media.sha256
        }
        if (!activated || !slotPresent) {
            return PrepareResult.Rejected(PlaybackRejection.NOT_ACTIVATED)
        }
        return prepare(MediaDownloader.targetFile(mediaDirectory, media).absolutePath)
    }

    /**
     * Bereitet eine lokale Datei vor. Erlaubt sind ausschliesslich vorhandene
     * regulaere Dateien, deren kanonischer Pfad in [mediaDirectory] liegt.
     * URIs, fehlende Dateien und Ausbruchsversuche werden abgelehnt.
     */
    internal fun prepare(source: String): PrepareResult = synchronized(lock) {
        if (state == State.RELEASED) return PrepareResult.Rejected(PlaybackRejection.RELEASED)
        val file = when (val resolved = resolveLocalFile(source)) {
            is FileResolution.Rejected -> return PrepareResult.Rejected(resolved.reason)
            is FileResolution.Resolved -> resolved.file
        }
        // Eine gueltige neue Vorbereitung ersetzt eine laufende Wiedergabe.
        stopLocked()
        val next = ++generation
        return try {
            port.disableAudio()
            port.prepare(file, next)
            state = State.PREPARED
            PrepareResult.Prepared(next)
        } catch (_: Exception) {
            state = State.IDLE
            PrepareResult.Rejected(PlaybackRejection.PLAYER_ERROR)
        }
    }

    /** Bindet eine sichtbare Ansicht an den Player-Port; null loest die Bindung. */
    fun attachView(view: View?) {
        synchronized(lock) {
            if (state == State.RELEASED) return
            try {
                port.attachView(view)
            } catch (_: Exception) {
                // Ohne Oberflaeche bleibt die Wiedergabe moeglich.
            }
        }
    }

    /** Startet ausschliesslich eine erfolgreich vorbereitete Wiedergabe. */
    fun play(): PlaybackStart = synchronized(lock) {
        if (state == State.RELEASED) return PlaybackStart.Rejected(PlaybackRejection.RELEASED)
        if (state != State.PREPARED) return PlaybackStart.Rejected(PlaybackRejection.NOT_PREPARED)
        return try {
            port.play()
            state = State.PLAYING
            val event = PlaybackEvent.Started(generation)
            observer?.onEvent(event)
            PlaybackStart.Started(generation)
        } catch (_: Exception) {
            state = State.IDLE
            PlaybackStart.Rejected(PlaybackRejection.PLAYER_ERROR)
        }
    }

    /** Stoppt eine vorbereitete oder laufende Wiedergabe; mehrfach aufrufbar. */
    fun stop() {
        synchronized(lock) {
            if (state == State.RELEASED) return
            stopLocked()
        }
    }

    /** Gibt den Player frei; mehrfach aufrufbar. Danach ist der Adapter unbrauchbar. */
    fun release() {
        synchronized(lock) {
            if (state == State.RELEASED) return
            // Generation zuerst entwerten, damit synchrone Callbacks waehrend
            // der Freigabe keine aktuellen Aktionen mehr ausloesen koennen.
            generation++
            state = State.RELEASED
            try {
                port.release()
            } catch (_: Exception) {
                // Freigeben bleibt best effort; der Adapter ist bereits entwertet.
            }
        }
    }

    private fun stopLocked() {
        if (state == State.PREPARED || state == State.PLAYING) {
            generation++
            try {
                port.stop()
            } catch (_: Exception) {
                // Der Zustand wird unabhaengig davon auf IDLE zurueckgesetzt.
            }
        }
        state = State.IDLE
    }

    private fun handleEnded(playbackGeneration: Long) {
        val event: PlaybackEvent? = synchronized(lock) {
            if (state == State.PLAYING && playbackGeneration == generation) {
                state = State.IDLE
                PlaybackEvent.Ended(playbackGeneration)
            } else {
                null
            }
        }
        if (event != null) observer?.onEvent(event)
    }

    private fun handleError(playbackGeneration: Long, reason: PlaybackRejection) {
        val event: PlaybackEvent? = synchronized(lock) {
            if ((state == State.PREPARED || state == State.PLAYING) && playbackGeneration == generation) {
                state = State.IDLE
                PlaybackEvent.Failed(playbackGeneration, reason)
            } else {
                null
            }
        }
        if (event != null) observer?.onEvent(event)
    }

    private sealed interface FileResolution {
        class Resolved(val file: File) : FileResolution
        class Rejected(val reason: PlaybackRejection) : FileResolution
    }

    private fun resolveLocalFile(source: String): FileResolution {
        val raw = source.trim()
        if (raw.isEmpty()) return FileResolution.Rejected(PlaybackRejection.UNSUPPORTED_SOURCE)
        if (raw.contains("://") || SCHEME.matches(raw)) {
            return FileResolution.Rejected(PlaybackRejection.UNSUPPORTED_SOURCE)
        }
        val root = try {
            mediaDirectory.canonicalFile
        } catch (_: Exception) {
            return FileResolution.Rejected(PlaybackRejection.OUTSIDE_MEDIA_DIRECTORY)
        }
        val candidate = try {
            File(raw).canonicalFile
        } catch (_: Exception) {
            return FileResolution.Rejected(PlaybackRejection.OUTSIDE_MEDIA_DIRECTORY)
        }
        if (!candidate.toPath().startsWith(root.toPath())) {
            return FileResolution.Rejected(PlaybackRejection.OUTSIDE_MEDIA_DIRECTORY)
        }
        if (!candidate.isFile) {
            return FileResolution.Rejected(PlaybackRejection.NOT_A_FILE)
        }
        return FileResolution.Resolved(candidate)
    }

    private companion object {
        /** Jede URI mit Schema, z. B. http:, https:, content: oder file:. */
        val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")
    }
}


