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
import gtads.device.playback.PlaybackController
import gtads.device.playback.PlaybackRuntime
import gtads.device.playback.PlaybackUiState
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
 * Hintergrundwiedergabe (R-904 bis R-907 bleiben spaetere Pakete).
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

    private val listener: (RegistrationScreenState) -> Unit = { render(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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

        playback = PlaybackRuntime.createController(this) { state -> renderPlayback(state) }

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
        // Liest den aktuellen aktivierten Stand und startet genau eine Schleife.
        startPlayback()
    }

    override fun onStop() {
        // Keine Wiedergabe und kein Timer ausserhalb des sichtbaren Vordergrunds.
        stopPlayback()
        super.onStop()
    }

    override fun onDestroy() {
        playback?.stop()
        playback = null
        RegistrationProcess.remove(listener)
        super.onDestroy()
    }

    /** Testbarer Einstiegspunkt; identisch zum Lifecycle-Aufruf in onStart. */
    internal fun startPlayback() {
        playback?.start()
    }

    /** Testbarer Einstiegspunkt; identisch zum Lifecycle-Aufruf in onStop. */
    internal fun stopPlayback() {
        playback?.stop()
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
        // startet die Wiedergabe ohne Activity-Neustart, sofern ein Stand da ist.
        playback?.start()
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
