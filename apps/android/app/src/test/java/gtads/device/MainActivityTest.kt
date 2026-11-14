package gtads.device

import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityTest {
    private fun MainActivity.contentChildren(): List<View> {
        val content = findViewById<FrameLayout>(android.R.id.content)
        return (0 until content.childCount).map { content.getChildAt(it) }
    }

    @Test
    fun showsExactlyNotRegistered() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        try {
            val children = controller.get().contentChildren()
            assertEquals(1, children.size)
            assertTrue(children.single() is TextView)
            assertEquals("Nicht registriert", (children.single() as TextView).text.toString())
        } finally {
            controller.destroy()
        }
    }

    @Test
    fun recreatesStaticStartScreenAfterDestruction() {
        val first = Robolectric.buildActivity(MainActivity::class.java).setup()
        val firstText: String
        try {
            firstText = (first.get().contentChildren().single() as TextView).text.toString()
            assertEquals("Nicht registriert", firstText)
        } finally {
            first.destroy()
        }

        val second = Robolectric.buildActivity(MainActivity::class.java).setup()
        try {
            val children = second.get().contentChildren()
            assertEquals(1, children.size)
            assertTrue(children.single() is TextView)
            assertEquals(firstText, (children.single() as TextView).text.toString())
            assertEquals("Nicht registriert", (children.single() as TextView).text.toString())
        } finally {
            second.destroy()
        }
    }
}
