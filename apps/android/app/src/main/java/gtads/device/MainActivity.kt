package gtads.device

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Minimale native Registrierungsoberflaeche. Sie enthaelt keine eigene
 * HTTP- oder Registrierungslogik, sondern nutzt ausschliesslich den
 * prozessgebundenen [RegistrationProcess] (Coordinator und Repository).
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

        // Code weder sichern noch vorschlagen oder automatisch ausfuellen.
        codeInput.isSaveEnabled = false
        codeInput.isSaveFromParentEnabled = false
        codeInput.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS

        registerButton.setOnClickListener { submit() }

        render(RegistrationScreenState.Loading)
        RegistrationProcess.observe(listener)
        RegistrationProcess.load(this)
    }

    override fun onDestroy() {
        RegistrationProcess.remove(listener)
        super.onDestroy()
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
    }
}
