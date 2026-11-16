package gtads.device

import android.content.Context
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import gtads.device.registration.REGISTRATION_FILE_NAME
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityTest {
    private lateinit var context: Context
    private lateinit var file: File

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        file = File(context.noBackupFilesDir, REGISTRATION_FILE_NAME)
        deleteStored()
        RegistrationProcess.resetForTest()
    }

    @After
    fun tearDown() {
        RegistrationProcess.resetForTest()
        deleteStored()
    }

    private fun deleteStored() {
        file.delete()
        File(file.path + ".new").delete()
        File(file.path + ".bak").delete()
    }

    private fun MainActivity.status(): String =
        findViewById<TextView>(R.id.registration_status).text.toString()

    @Test
    fun showsExactlyNotRegistered() {
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        try {
            controller.setup()
            val activity = controller.get()
            awaitUi {
                activity.status() == activity.getString(R.string.registration_message_not_registered)
            }
            assertEquals(
                activity.getString(R.string.registration_message_not_registered),
                activity.status(),
            )
            assertTrue(activity.findViewById<Button>(R.id.registration_button).isEnabled)
            assertEquals("", activity.findViewById<EditText>(R.id.registration_code_input).text.toString())
        } finally {
            controller.destroy()
        }
    }

    @Test
    fun recreatesStaticStartScreenAfterDestruction() {
        val first = Robolectric.buildActivity(MainActivity::class.java)
        val firstText: String
        try {
            first.setup()
            awaitUi {
                first.get().status() == first.get().getString(R.string.registration_message_not_registered)
            }
            firstText = first.get().status()
            first.get().findViewById<EditText>(R.id.registration_code_input)
                .setText("ABCD-EFGH-JKMN")
            val saved = Bundle()
            first.saveInstanceState(saved)
            assertFalse(bundleContains(saved, "ABCD-EFGH-JKMN"))
        } finally {
            first.destroy()
        }

        val second = Robolectric.buildActivity(MainActivity::class.java)
        try {
            second.setup()
            val activity = second.get()
            awaitUi {
                activity.status() == activity.getString(R.string.registration_message_not_registered)
            }
            assertEquals(firstText, activity.status())
            assertEquals(
                activity.getString(R.string.registration_message_not_registered),
                activity.status(),
            )
            assertEquals("", activity.findViewById<EditText>(R.id.registration_code_input).text.toString())
        } finally {
            second.destroy()
        }
    }
}
