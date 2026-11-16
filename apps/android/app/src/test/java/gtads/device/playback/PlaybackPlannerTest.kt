package gtads.device.playback

import gtads.device.manifest.ActiveManifest
import gtads.device.manifest.ManifestRepository
import gtads.device.manifest.ManifestVerification
import gtads.device.manifest.ParsedManifest
import gtads.device.manifest.verifyManifest
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlaybackPlannerTest {
    private val keyPair: KeyPair = KeyPairGenerator.getInstance("EC").apply {
        initialize(ECGenParameterSpec("secp256r1"))
    }.generateKeyPair()

    private class Spot(val mediaId: String, val durationMs: Long, val startAt: String, val endAt: String)

    private fun spot(mediaId: String, durationMs: Long = 10_000, startAt: String = DAY_START, endAt: String = DAY_END) =
        Spot(mediaId, durationMs, startAt, endAt)

    /** Signiert ein synthetisches Manifest und liefert den Schnappschuss wie nach CX-076-Aktivierung. */
    private fun snapshot(vararg spots: Spot): ActiveManifest {
        val entries = JSONArray()
        for (s in spots) {
            entries.put(
                JSONObject()
                    .put("mediaId", s.mediaId)
                    .put("sha256", sha256Hex(s.mediaId.toByteArray()))
                    .put("sizeBytes", 1024)
                    .put("durationMs", s.durationMs)
                    .put("campaignId", "SYN-campaign-${s.mediaId}")
                    .put("startAt", s.startAt)
                    .put("endAt", s.endAt),
            )
        }
        val payload = JSONObject()
            .put("schemaVersion", 1)
            .put("environment", "dev")
            .put("taxiId", TAXI_ID)
            .put("slotCount", spots.size)
            .put("entries", entries)
            .toString().toByteArray(Charsets.UTF_8)
        val payloadBase64 = Base64.getEncoder().encodeToString(payload)
        val version = sha256Hex(payload)
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(keyPair.private)
            update("gt-ads-manifest-v1\nSYN-key\n$version\n$payloadBase64".toByteArray(Charsets.UTF_8))
            sign()
        }
        val bytes = JSONObject()
            .put("schemaVersion", 1)
            .put("keyId", "SYN-key")
            .put("version", version)
            .put("payloadBase64", payloadBase64)
            .put("signatureBase64", Base64.getEncoder().encodeToString(signature))
            .toString().toByteArray(Charsets.UTF_8)
        val verified = verifyManifest(bytes, keyPair.public, TAXI_ID) as ManifestVerification.Verified
        val parsed = ManifestRepository.parseManifest(verified)!!
        return ActiveManifest(bytes, sha256Hex(bytes), "\"SYN-etag\"", parsed)
    }

    private fun play(decision: PlaybackDecision): PlaybackDecision.Play {
        assertTrue("erwartet Play, war $decision", decision is PlaybackDecision.Play)
        return decision as PlaybackDecision.Play
    }

    @Test
    fun manifestOrderAndLoopReturnAreDeterministic() {
        val manifest = snapshot(spot("SYN-a"), spot("SYN-b", durationMs = 15_000), spot("SYN-a"), spot("SYN-c"))
        val now = Instant.parse("2026-12-01T10:00:00Z")

        val sequence = ArrayList<String>()
        var previous: Int? = null
        repeat(6) {
            val next = play(planNextSlot(manifest, now, previous))
            sequence.add("${next.position}:${next.slot.media.mediaId}")
            previous = next.position
        }
        // Mehrfache Slots desselben Mediums bleiben erhalten, am Ende Ruecksprung an den Anfang.
        assertEquals(listOf("0:SYN-a", "1:SYN-b", "2:SYN-a", "3:SYN-c", "0:SYN-a", "1:SYN-b"), sequence)
        assertEquals(now.plusMillis(15_000), play(planNextSlot(manifest, now, 0)).stopAt)

        // Unbekannte bisherige Position beginnt deterministisch vorn.
        assertEquals(0, play(planNextSlot(manifest, now, 99)).position)
        assertEquals(0, play(planNextSlot(manifest, now, -1)).position)
        assertEquals(sequence, run {
            val again = ArrayList<String>()
            var p: Int? = null
            repeat(6) { val n = play(planNextSlot(manifest, now, p)); again.add("${n.position}:${n.slot.media.mediaId}"); p = n.position }
            again
        })
    }

    @Test
    fun startIsInclusiveEndIsExclusiveAndExpiredSpotsAreSkipped() {
        val start = "2026-12-01T10:00:00Z"
        val end = "2026-12-01T10:00:05Z"
        val manifest = snapshot(
            spot("SYN-expired", startAt = "2026-12-01T08:00:00Z", endAt = start),
            spot("SYN-window", durationMs = 10_000, startAt = start, endAt = end),
            spot("SYN-later", startAt = end, endAt = DAY_END),
        )

        // Genau am Beginn zulaessig; der abgelaufene Spot (Ende == jetzt) wird sofort uebergangen.
        val atStart = play(planNextSlot(manifest, Instant.parse(start), null))
        assertEquals("SYN-window", atStart.slot.media.mediaId)
        // Kampagnenende begrenzt vor der Spotdauer.
        assertEquals(Instant.parse(end), atStart.stopAt)

        // Kurz vor Ende noch zulaessig, begrenzt auf das Ende.
        val justBefore = play(planNextSlot(manifest, Instant.parse(end).minusMillis(1), 0))
        assertEquals("SYN-window", justBefore.slot.media.mediaId)
        assertEquals(Instant.parse(end), justBefore.stopAt)

        // Genau am Ende ausgeschlossen; der naechste beginnt dort inklusive.
        val atEnd = play(planNextSlot(manifest, Instant.parse(end), 0))
        assertEquals("SYN-later", atEnd.slot.media.mediaId)
        assertEquals(Instant.parse(end).plusMillis(10_000), atEnd.stopAt)
    }

    private class MutableClock(var now: Instant) : Clock() {
        override fun getZone(): ZoneId = ZoneOffset.UTC
        override fun withZone(zone: ZoneId?): Clock = this
        override fun instant(): Instant = now
    }

    @Test
    fun emptyOrInadmissibleListsAndClockJumpsYieldExplicitEmpty() {
        val empty = ActiveManifest(ByteArray(1), "0".repeat(64), "\"SYN\"", ParsedManifest(emptyList(), emptyList()))
        assertSame(PlaybackDecision.Empty, planNextSlot(empty, Instant.parse("2026-12-01T10:00:00Z"), null))

        val manifest = snapshot(
            spot("SYN-1", startAt = "2026-12-01T09:00:00Z", endAt = "2026-12-01T11:00:00Z"),
            spot("SYN-2", startAt = "2026-12-01T09:30:00Z", endAt = "2026-12-01T10:30:00Z"),
        )
        val clock = MutableClock(Instant.parse("2026-12-01T10:00:00Z"))
        val planner = PlaybackPlanner(clock)
        assertEquals("SYN-1", play(planner.next(manifest, null)).slot.media.mediaId)

        // Zeitsprung zurueck vor alle Fenster: kein erfundener Ersatzspot.
        clock.now = Instant.parse("2026-01-01T00:00:00Z")
        for (previous in listOf(null, 0, 1, 7)) assertSame(PlaybackDecision.Empty, planner.next(manifest, previous))

        // Zeitsprung nach vorn: nur noch SYN-1 zulaessig, keine Endlosschleife.
        clock.now = Instant.parse("2026-12-01T10:45:00Z")
        assertEquals("SYN-1", play(planner.next(manifest, 0)).slot.media.mediaId)
        assertEquals("SYN-1", play(planner.next(manifest, 1)).slot.media.mediaId)

        // Weit in der Zukunft: alles abgelaufen.
        clock.now = Instant.parse("2027-06-01T00:00:00Z")
        assertSame(PlaybackDecision.Empty, planner.next(manifest, 0))
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    private companion object {
        const val TAXI_ID = "SYN-taxi-1"
        const val DAY_START = "2026-12-01T00:00:00Z"
        const val DAY_END = "2026-12-02T00:00:00Z"
    }
}
