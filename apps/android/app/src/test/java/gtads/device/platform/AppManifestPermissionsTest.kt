package gtads.device.platform

import android.content.pm.PackageManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Netzberechtigungen sind vorhanden; Standort- und Sensorberechtigungen bleiben ausgeschlossen. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppManifestPermissionsTest {
    @Test
    fun networkPermissionsAreDeclaredAndLocationOrSensorPermissionsAreNot() {
        val app = RuntimeEnvironment.getApplication()
        val requested = app.packageManager
            .getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions?.toSet() ?: emptySet()
        assertTrue(requested.contains("android.permission.INTERNET"))
        assertTrue(requested.contains("android.permission.ACCESS_NETWORK_STATE"))
        for (forbidden in listOf(
            "android.permission.ACCESS_FINE_LOCATION",
            "android.permission.ACCESS_COARSE_LOCATION",
            "android.permission.ACCESS_BACKGROUND_LOCATION",
            "android.permission.BODY_SENSORS",
            "android.permission.CAMERA",
            "android.permission.RECORD_AUDIO",
        )) {
            assertFalse(forbidden, requested.contains(forbidden))
        }
    }
}
