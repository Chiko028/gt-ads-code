package gtads.device

import android.os.Bundle
import android.os.Looper
import org.robolectric.Shadows.shadowOf

/** Entleert die Hauptthread-Warteschlange deterministisch. */
internal fun idleMain() {
    shadowOf(Looper.getMainLooper()).idle()
}

/** Wartet begrenzt auf einen UI-Zustand; echte Hintergrundarbeit bleibt erlaubt. */
internal fun awaitUi(timeoutMs: Long = 5_000, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        idleMain()
        if (condition()) return
        Thread.sleep(5)
    }
    idleMain()
    if (!condition()) {
        throw AssertionError("Erwarteter UI-Zustand wurde nicht erreicht")
    }
}

/** Prueft rekursiv, ob ein Saved-State-Wert den Text enthaelt. */
internal fun bundleContains(bundle: Bundle?, needle: String): Boolean {
    if (bundle == null) return false
    return bundle.keySet().any { key ->
        when (val value = bundle.get(key)) {
            null -> false
            is String -> value.contains(needle)
            is CharSequence -> value.contains(needle)
            is Bundle -> bundleContains(value, needle)
            else -> value.toString().contains(needle)
        }
    }
}
