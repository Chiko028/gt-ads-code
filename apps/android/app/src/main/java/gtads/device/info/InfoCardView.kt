package gtads.device.info

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.TextUtils
import android.util.AttributeSet
import android.util.TypedValue
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView

/** Querformat-Karte in GT-Ads-Farben; Textgroessen passen sich der Flaeche an. */
class InfoCardView(context: Context, attrs: AttributeSet? = null) : LinearLayout(context, attrs) {
    init {
        orientation = VERTICAL
        setBackgroundColor(NAVY)
        val density = resources.displayMetrics.density
        setPadding((40 * density).toInt(), (20 * density).toInt(), (40 * density).toInt(), (14 * density).toInt())
    }

    fun show(card: InfoCard) {
        removeAllViews()
        when (card) {
            is InfoCard.Weather -> showWeather(card)
            is InfoCard.News -> showNews(card)
        }
        addView(text(card.source, 18, MUTED).apply { gravity = Gravity.CENTER_VERTICAL }, row(0.6f))
    }

    private fun showWeather(card: InfoCard.Weather) {
        addView(text("Wetter in ${card.city}", 44, GOLD, bold = true), row(1f))
        val columns = LinearLayout(context).apply { orientation = HORIZONTAL }
        val now = column()
        now.addView(text(card.now.symbol, 110, Color.WHITE), row(1.3f))
        now.addView(text("${card.now.temperature}°", 120, Color.WHITE, bold = true), row(1.5f))
        now.addView(text(card.now.condition.label, 34, MUTED), row(0.7f))
        columns.addView(now, LayoutParams(0, LayoutParams.MATCH_PARENT, 1f))
        val later = column()
        for (entry in card.later) {
            later.addView(
                text("${entry.label}   ${entry.symbol}   ${entry.temperature}°", 44, Color.WHITE)
                    .apply { gravity = Gravity.CENTER_VERTICAL },
                row(1f),
            )
        }
        columns.addView(later, LayoutParams(0, LayoutParams.MATCH_PARENT, 1.4f))
        addView(columns, row(5f))
    }

    private fun showNews(card: InfoCard.News) {
        addView(text("Aktuelles aus Wien", 44, GOLD, bold = true), row(1f))
        for (title in card.titles) {
            addView(
                text("•  $title", 46, Color.WHITE, lines = 2).apply { gravity = Gravity.CENTER_VERTICAL },
                row(5f / card.titles.size),
            )
        }
    }

    private fun column() = LinearLayout(context).apply { orientation = VERTICAL }

    private fun row(weight: Float) = LayoutParams(LayoutParams.MATCH_PARENT, 0, weight)

    private fun text(value: String, maxSp: Int, color: Int, bold: Boolean = false, lines: Int = 1) =
        TextView(context).apply {
            text = value
            setTextColor(color)
            if (bold) setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
            maxLines = lines
            ellipsize = TextUtils.TruncateAt.END
            setAutoSizeTextTypeUniformWithConfiguration(10, maxSp, 1, TypedValue.COMPLEX_UNIT_SP)
        }

    private companion object {
        val NAVY = Color.rgb(0x07, 0x14, 0x2B)
        val GOLD = Color.rgb(0xF2, 0xA5, 0x1A)
        val MUTED = Color.rgb(0xC9, 0xD3, 0xE6)
    }
}
