package gtads.device.identity

import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceIdentityInitializationTest {
    @Test
    fun twoInitializationsCreateOneKeyAndNewInstanceOpensItWithoutCreation() {
        val store = TestIdentityKeyStore()
        val ready = CountDownLatch(2)
        val go = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val futures = (1..2).map {
                pool.submit(
                    Callable<ByteArray> {
                        ready.countDown()
                        go.await()
                        DeviceIdentity(store).initializeForEnrollment()
                    },
                )
            }
            assertTrue("beide Initialisierungen starten", ready.await(5, TimeUnit.SECONDS))
            go.countDown()
            val first = futures[0].get(10, TimeUnit.SECONDS)
            val second = futures[1].get(10, TimeUnit.SECONDS)

            assertEquals("genau ein Schluessel", listOf(TEST_ALIAS), store.createdAliases)
            assertArrayEquals(first, second)

            val reopened = DeviceIdentity(store).openExisting()
            assertArrayEquals(first, reopened)
            assertEquals(1, store.createCalls)

            val reinitialized = DeviceIdentity(store).initializeForEnrollment()
            assertArrayEquals(first, reinitialized)
            assertEquals(1, store.createCalls)
        } finally {
            pool.shutdownNow()
        }
    }
}
