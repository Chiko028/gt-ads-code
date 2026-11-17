package gtads.device.playback

import android.content.Context
import android.os.SystemClock
import android.view.View
import gtads.device.manifest.ActiveManifest
import gtads.device.manifest.ManifestSlot
import java.time.Clock
import java.time.Instant

/** Sichtbarer Zustand der lokalen Wiedergabe; keine Bedien- oder Kioskzustaende. */
enum class PlaybackUiState {
    /** Kein aktiver Schnappschuss bzw. Wiedergabe beendet; Registrierung bleibt sichtbar. */
    IDLE,

    /** Ein lokaler Spot laeuft. */
    PLAYING,

    /** Aktivierter Stand vorhanden, aber kein zulaessiger lokaler Spot. */
    EMPTY,
}

/**
 * Lifecyclegebundene Offline-Wiedergabe (CX-082 / R-903).
 *
 * Der Controller verbindet den aktivierten Schnappschuss (CX-076), den Planer
 * (CX-080) und den lokalen Playeradapter (CX-081). Er ist bewusst klein: keine
 * Hintergrundarbeit, kein Foreground-Service, keine Telemetrie, keine Pause.
 *
 * Zeitregeln:
 * - absolute Gueltigkeit und Kampagnenende werden in UTC ueber [clock] geprueft,
 *   waehrend sichtbarer Wiedergabe mindestens einmal pro Sekunde;
 * - die verstrichene Slotdauer wird monoton ueber [monotonicMillis] gemessen;
 * - der Timer wird auf die frueheste Grenze aus Slotdauer, Kampagnenende und
 *   Pruefintervall geplant und ist abbrechbar.
 *
 * Ein neuer aktivierter Schnappschuss wird nur am Slotwechsel gelesen. Ein
 * fehlender oder unvollstaendiger Kandidat ersetzt die laufende Auswahl nicht.
 * Fehlende oder fehlerhafte Medien werden hoechstens einmal je Durchlauf
 * uebersprungen; ist die Auswahl vollstaendig leer, wird angehalten und
 * [PlaybackUiState.EMPTY] gemeldet. Die Activity zeigt dann den eingebauten
 * statischen GT-Ads-Platzhalter (CX-092 / R-909): keine Kampagnenwiedergabe,
 * keine Spotkennung, kein Download.
 */
class PlaybackController internal constructor(
    private val adapterFactory: (PlaybackObserver) -> LocalMediaPlayerAdapter,
    private val clock: Clock,
    private val snapshots: () -> ActiveManifest?,
    private val timer: PlaybackTimer,
    private val listener: (PlaybackUiState) -> Unit = {},
    private val monotonicMillis: () -> Long = { SystemClock.elapsedRealtime() },
    private val tickMs: Long = DEFAULT_TICK_MS,
    private val playbackPermitted: () -> Boolean = { true },
    /** CX-098: Android-Zeit-/Zeitzonenaenderungen; lebenszyklusgebunden angemeldet. */
    private val clockChanges: ClockChangeSource = NoClockChanges,
) {
    /** Produktive Verdrahtung: lokaler Speicher, Main-Looper, Systemuhren. */
    constructor(context: Context, listener: (PlaybackUiState) -> Unit) : this(
        adapterFactory = { observer -> LocalMediaPlayerAdapter(context.applicationContext, observer) },
        clock = Clock.systemUTC(),
        snapshots = PlaybackRuntime.snapshotProvider(context),
        timer = HandlerPlaybackTimer(),
        listener = listener,
        clockChanges = AndroidClockChangeSource(context),
    )

    /** Produktive Verdrahtung mit externer CX-083-Freigabe. */
    constructor(
        context: Context,
        listener: (PlaybackUiState) -> Unit,
        playbackPermitted: () -> Boolean,
    ) : this(
        adapterFactory = { observer -> LocalMediaPlayerAdapter(context.applicationContext, observer) },
        clock = Clock.systemUTC(),
        snapshots = PlaybackRuntime.snapshotProvider(context),
        timer = HandlerPlaybackTimer(),
        listener = listener,
        playbackPermitted = playbackPermitted,
        clockChanges = AndroidClockChangeSource(context),
    )

    private val planner = PlaybackPlanner(clock)

    private var running = false
    private var state = PlaybackUiState.IDLE
    private var adapter: LocalMediaPlayerAdapter? = null
    private var attachedView: View? = null
    private var timerHandle: PlaybackTimer.Cancellable? = null
    private var clockSubscription: PlaybackTimer.Cancellable? = null
    private var snapshot: ActiveManifest? = null
    private var slot: ManifestSlot? = null
    private var stopAt: Instant? = null
    private var slotStartedMono = 0L
    private var playingGeneration: Long? = null
    private var previousPosition: Int? = null
    private val skipped = LinkedHashSet<Int>()

    private val observer = PlaybackObserver { event -> handleEvent(event) }

    /** Startet genau eine Wiedergabeschleife; wiederholte Aufrufe sind wirkungslos. */
    fun start() {
        if (running) return
        if (!playbackPermitted()) {
            // CX-083-Freigabe: ohne Bereitschaft ON wird nicht gestartet.
            publish(PlaybackUiState.IDLE)
            return
        }
        running = true
        clockSubscription?.cancel()
        clockSubscription = try {
            clockChanges.subscribe { onClockChanged() }
        } catch (_: Exception) {
            null
        }
        skipped.clear()
        snapshot = null
        slot = null
        stopAt = null
        playingGeneration = null
        previousPosition = null
        val current = refreshSnapshot()
        if (current == null) {
            // Noch kein aktivierter Stand (z. B. nicht registriert): Anzeige unveraendert.
            running = false
            unsubscribeClock()
            publish(PlaybackUiState.IDLE)
            return
        }
        selectNext(current, null)
    }

    /** Beendet Wiedergabe und Timer und gibt den Player frei; mehrfach aufrufbar. */
    fun stop() {
        running = false
        unsubscribeClock()
        cancelTimer()
        playingGeneration = null
        slot = null
        stopAt = null
        previousPosition = null
        snapshot = null
        skipped.clear()
        releaseAdapter()
        publish(PlaybackUiState.IDLE)
    }

    /**
     * CX-098: Wanduhr oder Zeitzone hat sich geaendert. Alte Zeitplanung wird
     * verworfen; ein laufender Spot ausserhalb seines Fensters wird sofort
     * beendet, sonst genau ein neuer begrenzter Termin gesetzt.
     */
    fun onClockChanged() {
        if (!running) return
        cancelTimer()
        if (slot == null) {
            // Kein laufender Spot (z. B. EMPTY): vorhandenen Scheduler erneut fragen.
            selectNext(previousPosition)
            return
        }
        reevaluateRunningSlot()
    }

    private fun unsubscribeClock() {
        val subscription = clockSubscription ?: return
        clockSubscription = null
        try {
            subscription.cancel()
        } catch (_: Exception) {
            // Abmeldung ist best effort.
        }
    }

    /**
     * CX-092: Wiedergabe ist erlaubt, der Scheduler liefert aber keinen gueltigen
     * lokalen Eintrag; angezeigt wird der statische Platzhalter. Fuer den
     * Watchdog ist das kein festhaengender Video-Player.
     */
    fun isStaticFallback(): Boolean = running && state == PlaybackUiState.EMPTY

    /** CX-089: Fortschrittsprobe der laufenden Wiedergabe (Generation, Position) oder null. */
    fun progressSample(): gtads.device.watchdog.PlaybackProgress? {
        if (!running || playingGeneration == null) return null
        val (generation, position) = adapter?.progress() ?: return null
        return gtads.device.watchdog.PlaybackProgress(generation, position.coerceAtLeast(0L))
    }

    /** CX-089: aktuelle, bereits gepruefte Planung des laufenden Spots. */
    fun currentPlanning(): PlaybackDecision {
        val current = slot ?: return PlaybackDecision.Empty
        val limit = stopAt ?: return PlaybackDecision.Empty
        return PlaybackDecision.Play(current, limit)
    }

    /** Bindet die sichtbare Media3-Ansicht; null loest die Bindung. */
    fun attachView(view: View?) {
        attachedView = view
        adapter?.attachView(view)
    }

    private fun handleEvent(event: PlaybackEvent) {
        if (!running) return
        when (event) {
            is PlaybackEvent.Started -> Unit
            is PlaybackEvent.Ended -> {
                if (event.generation == playingGeneration) {
                    advanceFrom(previousPosition, null)
                }
            }
            is PlaybackEvent.Failed -> {
                if (event.generation == playingGeneration) {
                    advanceFrom(previousPosition, previousPosition)
                }
            }
        }
    }

    private fun advanceFrom(previous: Int?, failedPosition: Int?) {
        if (!running) return
        if (failedPosition != null) skipped.add(failedPosition)
        selectNext(previous)
    }

    private fun selectNext(previous: Int?) {
        if (!running) return
        cancelTimer()
        stopCurrentPlayback()
        val current = refreshSnapshot()
        if (current == null) {
            publish(PlaybackUiState.IDLE)
            return
        }
        selectNext(current, previous)
    }

    private fun selectNext(current: ActiveManifest, previous: Int?) {
        val participants = current.slots
        if (participants.isEmpty()) {
            publish(PlaybackUiState.EMPTY)
            // CX-092: begrenzter Termin, damit ein neu aktivierter Stand den Fallback abloest.
            scheduleIdleRecheck(current)
            return
        }
        var cursor = previous
        var examined = 0
        while (examined <= participants.size && running) {
            val decision = planner.next(current, cursor)
            if (decision !is PlaybackDecision.Play) {
                publish(PlaybackUiState.EMPTY)
                scheduleIdleRecheck(current)
                return
            }
            val position = decision.position
            if (position in skipped) {
                cursor = position
                examined++
                continue
            }
            val engine = ensureAdapter()
            val prepared = try {
                engine.prepare(current, decision)
            } catch (_: Exception) {
                PrepareResult.Rejected(PlaybackRejection.PLAYER_ERROR)
            }
            if (prepared !is PrepareResult.Prepared) {
                skipped.add(position)
                cursor = position
                examined++
                continue
            }
            val started = try {
                engine.play()
            } catch (_: Exception) {
                PlaybackStart.Rejected(PlaybackRejection.PLAYER_ERROR)
            }
            if (started !is PlaybackStart.Started) {
                skipped.add(position)
                cursor = position
                examined++
                continue
            }
            slot = decision.slot
            stopAt = decision.stopAt
            slotStartedMono = monotonicMillis()
            playingGeneration = prepared.generation
            previousPosition = position
            publish(PlaybackUiState.PLAYING)
            scheduleCheck()
            return
        }
        publish(PlaybackUiState.EMPTY)
    }

    /**
     * Liest den Kandidaten nur am Slotwechsel. Unvollstaendige Staende mit nicht
     * referenzierten Medien ersetzen den aktiven Stand nicht.
     */
    private fun refreshSnapshot(): ActiveManifest? {
        val candidate = try {
            snapshots()
        } catch (_: Exception) {
            null
        }
        if (candidate != null && isUsable(candidate)) {
            snapshot = candidate
            skipped.clear()
        }
        return snapshot
    }

    private fun isUsable(candidate: ActiveManifest): Boolean {
        val media = candidate.media
        return candidate.slots.all { item ->
            media.any { it.mediaId == item.media.mediaId && it.sha256 == item.media.sha256 }
        }
    }

    private fun ensureAdapter(): LocalMediaPlayerAdapter {
        adapter?.let { return it }
        val created = adapterFactory(observer)
        created.attachView(attachedView)
        adapter = created
        return created
    }

    private fun stopCurrentPlayback() {
        playingGeneration = null
        slot = null
        stopAt = null
        try {
            adapter?.stop()
        } catch (_: Exception) {
            // Der alte Player wird unabhaengig davon nicht weiter verwendet.
        }
    }

    private fun releaseAdapter() {
        val current = adapter ?: return
        adapter = null
        try {
            current.attachView(null)
        } catch (_: Exception) {
            // Die Freigabe darunter bleibt best effort.
        }
        try {
            current.release()
        } catch (_: Exception) {
            // Der Controller ist bereits ohne Player.
        }
    }

    /** Plant die naechste Pruefung auf die frueheste Grenze, hoechstens [tickMs]. */
    private fun scheduleCheck() {
        cancelTimer()
        val limit = stopAt ?: return
        val currentSlot = slot ?: return
        val remainingUtc = limit.toEpochMilli() - clock.millis()
        val elapsed = monotonicMillis() - slotStartedMono
        val remainingSlot = currentSlot.durationMs - elapsed
        val delay = minOf(minOf(remainingUtc, remainingSlot), tickMs).coerceAtLeast(0L)
        timerHandle = timer.schedule(delay) { onTimer() }
    }

    /**
     * Prueft die UTC-Gueltigkeit erneut, auch wenn der Player kein Ende meldet.
     * Ein Uhrsprung nach vorn beendet den Spot spaetestens bei dieser Pruefung.
     */
    private fun onTimer() {
        timerHandle = null
        if (!running) return
        if (slot == null) {
            // Begrenzter Leerlauftermin: Scheduler erneut fragen.
            selectNext(previousPosition)
            return
        }
        reevaluateRunningSlot()
    }

    /**
     * Exklusive Endgrenzen gelten auch fuer laufende Spots; ein Rueckwaertssprung
     * vor den Fensterbeginn beendet den Spot ebenfalls sofort.
     */
    private fun reevaluateRunningSlot() {
        val currentSlot = slot ?: return
        val limit = stopAt ?: return
        val nowUtc = clock.instant()
        val elapsed = monotonicMillis() - slotStartedMono
        // REV-195: Laufzeitberechtigung aus dem Planer (dieselbe Regel wie bei der Auswahl), nur die
        // spotbezogenen Grenzen (stopAt, Spotdauer) bleiben hier.
        val stillPlayable = planner.isPlayable(currentSlot)
        if (!stillPlayable || !nowUtc.isBefore(limit) || elapsed >= currentSlot.durationMs) {
            advanceFrom(previousPosition, null)
        } else {
            scheduleCheck()
        }
    }

    /**
     * CX-098: Ohne zulaessigen Spot genau ein begrenzter Termin bis zum naechsten
     * Fensterbeginn, mindestens [tickMs], hoechstens [MAX_IDLE_RECHECK_MS]; keine
     * enge Wiederholungsschleife.
     */
    private fun scheduleIdleRecheck(current: ActiveManifest) {
        cancelTimer()
        val nowMs = clock.millis()
        val nextStart = current.slots
            .map { it.startAt.toEpochMilli() - nowMs }
            .filter { it > 0L }
            .minOrNull() ?: MAX_IDLE_RECHECK_MS
        val delay = nextStart.coerceIn(tickMs, MAX_IDLE_RECHECK_MS)
        timerHandle = timer.schedule(delay) { onTimer() }
    }

    private fun cancelTimer() {
        val handle = timerHandle ?: return
        timerHandle = null
        try {
            handle.cancel()
        } catch (_: Exception) {
            // Ein nicht abbrechbarer Timer darf den Zustandswechsel nicht blockieren.
        }
    }

    private fun publish(next: PlaybackUiState) {
        if (state == next) return
        state = next
        listener(next)
    }

    private companion object {
        const val DEFAULT_TICK_MS = 1_000L
        const val MAX_IDLE_RECHECK_MS = 60_000L
    }
}
