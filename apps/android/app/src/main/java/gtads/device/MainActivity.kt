package gtads.device

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import gtads.device.heartbeat.HeartbeatRuntime
import gtads.device.heartbeat.StatusReporter
import gtads.device.playback.PlaybackController
import gtads.device.playback.PlaybackRuntime
import gtads.device.playback.PlaybackUiState
import gtads.device.state.GateDecision
import gtads.device.state.PlaybackStateCoordinator
import gtads.device.sync.SyncScheduler

/**
 * Minimale native Registrierungsoberflaeche. Sie enthaelt keine eigene
 * HTTP- oder Registrierungslogik, sondern nutzt ausschliesslich den
 * prozessgebundenen [RegistrationProcess] (Coordinator und Repository).
 *
 * CX-082 ergaenzt die sichtbare lokale Offline-Wiedergabe: Nach erfolgreicher
 * Registrierung und bei vorhandenem aktiviertem Schnappschuss uebernimmt eine
 * Media3-PlayerView ohne Bedienelemente die Anzeige. Activity-Stopp beendet
 * Wiedergabe und Timer; ein erneuter Start liest den neuesten aktivierten
 * Stand. Es gibt keine Kiosk-Sperre, keinen Foreground-Service und keine
 * Hintergrundwiedergabe.
 *
 * CX-085 bindet den CX-083-Zustandsautomaten in genau diesen Lifecycle ein:
 * Die Wiedergabe startet nur bei freigegebener Bereitschaft, der
 * Display-Nachlauf folgt der konfigurierten Frist ueber das Fenster-Flag
 * KEEP_SCREEN_ON (keine globalen Geraeteeinstellungen, keine
 * Administratorrechte). Der StatusReporter laeuft nur zwischen onStart und
 * onStop.
 */
class MainActivity : Activity() {
    private lateinit var statusText: TextView
    private lateinit var form: LinearLayout
    private lateinit var registered: LinearLayout
    private lateinit var serverUrlInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var registerButton: Button
    private lateinit var deviceIdValue: TextView
    private lateinit var serverUrlValue: TextView
    private lateinit var registrationScroll: View
    private lateinit var playbackSurface: FrameLayout
    private lateinit var playbackEmpty: TextView

    private var playback: PlaybackController? = null
    private var playbackView: View? = null
    private var gate: PlaybackStateCoordinator? = null
    /** CX-153: nur zwischen onStart und onStop duerfen Entscheidungen starten. */
    @Volatile
    private var playbackActive = false
    /** CX-153: Auswertungsstand vor dem aktuellen Startversuch. */
    private var startAttemptBaseline = 0L
    private var reporter: StatusReporter? = null
    /** CX-091: Kiosk-Adapter; nur Release + lokale Konfiguration + Device Owner. */
    private var kiosk: gtads.device.kiosk.KioskPolicy? = null

    /** CX-089: Wiedergabe-Watchdog nur im aktiven Wiedergabelebenszyklus. */
    private var watchdogMonitor: gtads.device.watchdog.PlaybackWatchdogMonitor? = null
    @Volatile
    private var watchdogFault = false

    /** CX-087: Befehlsabruf nur im sichtbaren Vordergrund. */
    private var commands: gtads.device.control.CommandPollingLoop? = null

    private val listener: (RegistrationScreenState) -> Unit = { render(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // CX-149: gespeicherte Geraetekonfiguration an Synchronisierung und Befehlsabruf binden.
        gtads.device.config.DeviceRuntimeSetup.install()
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.registration_status)
        form = findViewById(R.id.registration_form)
        registered = findViewById(R.id.registration_registered)
        serverUrlInput = findViewById(R.id.server_url_input)
        codeInput = findViewById(R.id.registration_code_input)
        registerButton = findViewById(R.id.registration_button)
        deviceIdValue = findViewById(R.id.registered_device_id)
        serverUrlValue = findViewById(R.id.registered_server_url)
        registrationScroll = findViewById(R.id.registration_scroll)
        playbackSurface = findViewById(R.id.playback_surface)
        playbackEmpty = findViewById(R.id.playback_empty)

        // Code weder sichern noch vorschlagen oder automatisch ausfuellen.
        codeInput.isSaveEnabled = false
        codeInput.isSaveFromParentEnabled = false
        codeInput.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS

        registerButton.setOnClickListener { submit() }

        gate = PlaybackGateRuntime.create(
            this,
            { decision -> applyGate(decision) },
            {
                if (watchdogFault) gtads.device.state.PlayerCondition.ERROR else gtads.device.state.PlayerCondition.OK
            },
        )
        playback = PlaybackRuntime.createController(
            this,
            { state -> renderPlayback(state) },
            // CX-153: jeder tatsaechliche Start wertet die Bereitschaft neu aus;
            // fehlende oder fehlerhafte Entscheidungen sperren.
            PlaybackGateRuntime.playbackPermitted(this) { gate },
        )
        reporter = HeartbeatRuntime.create(this)
        watchdogMonitor = playback?.let { controller ->
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            gtads.device.watchdog.PlaybackWatchdogMonitor(
                controller = controller,
                state = { gate?.stateSnapshot() },
                watchdog = gtads.device.watchdog.PlaybackWatchdog(gtads.device.watchdog.ControllerPlaybackRecovery(controller)),
                schedule = { delay, action ->
                    val runnable = Runnable { action() }
                    handler.postDelayed(runnable, delay)
                    AutoCloseable { handler.removeCallbacks(runnable) }
                },
                onFault = { fault ->
                    watchdogFault = fault
                    gate?.refresh()
                },
            )
        }

        render(RegistrationScreenState.Loading)
        RegistrationProcess.observe(listener)
        RegistrationProcess.load(this)
    }

    override fun onStart() {
        super.onStart()
        try {
            SyncScheduler.ensurePeriodic(this)
        } catch (_: Exception) {
            // Ohne WorkManager bleibt die Registrierung nutzbar.
        }
        // CX-153: Nur der aktive Lebenszyklus darf Entscheidungen umsetzen;
        // der Basisstand trennt diesen Startversuch von frueheren.
        playbackActive = true
        startAttemptBaseline = gate?.evaluationCount() ?: 0L
        try {
            gate?.start()
        } catch (_: Throwable) {
            // Auswertungsfehler bleiben ein technischer Status, kein Absturz.
            PlaybackGateRuntime.reportTechnicalStatus(this, PlaybackGateRuntime.STATUS_EVALUATION_FAILED)
        }
        startPlayback()
        reporter?.start()
        if (commands == null) {
            commands = try {
                gtads.device.control.ControlRuntime.loop(this)
            } catch (_: Exception) {
                null
            }
        }
        commands?.start()
        watchdogMonitor?.start()
        if (kiosk == null) {
            kiosk = gtads.device.kiosk.KioskPolicy(
                gtads.device.kiosk.AndroidKioskPlatform(this),
                gtads.device.kiosk.SharedPreferencesKioskConfig(this),
                packageName,
            )
        }
        kiosk?.onActivityStarted()
    }

    override fun onStop() {
        // Keine Wiedergabe, kein Timer und kein Reporter ausserhalb des
        // sichtbaren Vordergrunds.
        playbackActive = false
        watchdogMonitor?.stop()
        commands?.stop()
        reporter?.stop()
        gate?.stop()
        stopPlayback()
        super.onStop()
    }

    override fun onDestroy() {
        playbackActive = false
        watchdogMonitor?.stop()
        watchdogMonitor = null
        gate?.stop()
        gate = null
        reporter?.stop()
        reporter = null
        playback?.stop()
        playback = null
        RegistrationProcess.remove(listener)
        super.onDestroy()
    }

    /** Testbarer Einstiegspunkt; jeder Aufruf beginnt einen neuen Startversuch. */
    internal fun startPlayback() {
        // CX-153: eine neue Bewertung gehoert zu genau diesem Startversuch.
        playbackActive = true
        startAttemptBaseline = gate?.evaluationCount() ?: 0L
        playback?.start()
    }

    /** Testbarer Einstiegspunkt; identisch zum Lifecycle-Aufruf in onStop. */
    internal fun stopPlayback() {
        playback?.stop()
    }

    /**
     * Uebernimmt die Entscheidung des Zustandsautomaten. Wiedergabe folgt
     * playbackAllowed, der Displaybedarf ausschliesslich dem Fenster-Flag.
     */
    private fun applyGate(decision: GateDecision) {
        // CX-153: verspaetete oder ueberholte Entscheidungen duerfen weder
        // starten noch den aktuellen Zustand ueberschreiben.
        if (!playbackActive) return
        val current = gate ?: return
        if (decision !== current.decision()) return
        if (current.evaluationCount() <= startAttemptBaseline) return
        if (decision.playbackAllowed) {
            playback?.start()
        } else {
            playback?.stop()
        }
        if (decision.displayRequired) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun submit() {
        val baseUrl = serverUrlInput.text.toString().trim()
        val code = codeInput.text.toString().trim()
        if (baseUrl.isEmpty() || code.isEmpty()) {
            render(RegistrationScreenState.Message(R.string.registration_message_invalid_input))
            return
        }
        if (RegistrationProcess.start(this, baseUrl, code)) {
            codeInput.setText("")
            render(RegistrationScreenState.InProgress)
        }
    }

    private fun render(state: RegistrationScreenState) {
        when (state) {
            RegistrationScreenState.Loading ->
                showForm(getString(R.string.registration_message_loading), enabled = false)
            RegistrationScreenState.InProgress ->
                showForm(getString(R.string.registration_message_progress), enabled = false)
            RegistrationScreenState.NotRegistered ->
                showForm(getString(R.string.registration_message_not_registered), enabled = true)
            is RegistrationScreenState.Message ->
                showForm(getString(state.messageRes), enabled = true)
            is RegistrationScreenState.Registered -> showRegistered(state)
        }
    }

    private fun showForm(message: String, enabled: Boolean) {
        form.visibility = View.VISIBLE
        registered.visibility = View.GONE
        statusText.visibility = View.VISIBLE
        statusText.text = message
        registerButton.isEnabled = enabled
    }

    private fun showRegistered(state: RegistrationScreenState.Registered) {
        form.visibility = View.GONE
        registered.visibility = View.VISIBLE
        statusText.visibility = View.GONE
        deviceIdValue.text = state.deviceId
        serverUrlValue.text = state.serverUrl
        // Registrierung kann waehrend der Activity abgeschlossen werden; dann
        // wertet der Zustandsautomat sofort neu aus.
        // CX-153: ohne Gate gibt es keine Freigabe und damit keinen Start.
        gate?.refresh()
    }

    private fun renderPlayback(state: PlaybackUiState) {
        when (state) {
            PlaybackUiState.IDLE -> {
                registrationScroll.visibility = View.VISIBLE
                playbackSurface.visibility = View.GONE
                playbackEmpty.visibility = View.GONE
            }
            PlaybackUiState.PLAYING -> {
                ensurePlaybackView()
                registrationScroll.visibility = View.GONE
                playbackSurface.visibility = View.VISIBLE
                playbackEmpty.visibility = View.GONE
            }
            PlaybackUiState.EMPTY -> {
                registrationScroll.visibility = View.GONE
                playbackSurface.visibility = View.GONE
                playbackEmpty.visibility = View.VISIBLE
            }
        }
    }

    /**
     * Erzeugt die Media3-Ansicht erst bei sichtbarer Wiedergabe. Fehlt die
     * optionale UI (z. B. in einer Testumgebung), bleibt die Activity nutzbar;
     * der Ton ist ohnehin deaktiviert.
     */
    private fun ensurePlaybackView() {
        if (playbackView != null) return
        val view = try {
            PlaybackRuntime.createSurface(this)
        } catch (_: Throwable) {
            return
        }
        playbackView = view
        playbackSurface.addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        playback?.attachView(view)
    }
}
