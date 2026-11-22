package gtads.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Geraetetest-Befund 2026-11-22 (S22+): Ohne versionName sendete die App
 * app_version "" und der Server lehnte die Registrierung als invalid_request ab
 * (Anzeige: "Registrierungscode abgelehnt").
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RegistrationAppVersionTest {
    @Test
    fun builtAppDeclaresNonBlankVersionName() {
        val context = RuntimeEnvironment.getApplication()
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val name = info.versionName
        assertTrue("versionName fehlt: $name", !name.isNullOrBlank())
        assertEquals(name!!.trim(), registrationAppVersion(name))
    }

    @Test
    fun missingOrBlankVersionFallsBackToNonEmptyValue() {
        assertEquals("0", registrationAppVersion(null))
        assertEquals("0", registrationAppVersion(""))
        assertEquals("0", registrationAppVersion("   "))
        assertEquals("1.2.3", registrationAppVersion(" 1.2.3 "))
        assertEquals(64, registrationAppVersion("x".repeat(100)).length)
    }
}
