package com.horizon.maxhelmet.companion
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class CompanionProtocolTest {
    @Test fun endpointRequiresAccountAndStripsOldTokenAndPath() {
        assertNull(CompanionProtocol.endpoint("wss://example.org/agent?token=operator", ""))
        assertEquals("https://example.org/companion?token=account", CompanionProtocol.endpoint("wss://example.org/agent?token=operator&x=y", "account"))
        assertNull(CompanionProtocol.endpoint("https://user:password@example.org", "account"))
    }
    @Test fun pairingAndDiscoveryValidate() {
        assertEquals("123456", JSONObject(CompanionProtocol.pair(" 123456 ")!!).getString("code"))
        assertNull(CompanionProtocol.pair("中".repeat(41))); assertNull(CompanionProtocol.discover("A".repeat(32)))
        assertNotNull(CompanionProtocol.discover("a".repeat(32)))
    }
    @Test fun malformedOrUnknownStateIgnored() {
        assertNull(CompanionProtocol.parse("{}")); assertNull(CompanionProtocol.parse("""{"type":"companion.status","state":"ready","deviceId":1}"""))
        assertNull(CompanionProtocol.parse("""{"type":"companion.status","state":"surprise"}"""))
        assertEquals("sharing", CompanionProtocol.parse("""{"type":"companion.status","state":"sharing"}""")!!.status)
    }
    @Test fun coordinatesRemainWgs84AndInvalidValuesRejected() {
        val fix = CompanionFix(31.123, 121.456, 5.0, 12345)
        assertEquals(31.123, JSONObject(CompanionProtocol.location(fix, 1)!!).getDouble("lat"), 0.0)
        assertNull(CompanionProtocol.location(fix.copy(lat = 91.0), 1)); assertNull(CompanionProtocol.location(fix.copy(accuracy = Double.NaN), 1))
        assertNull(CompanionProtocol.location(fix, 0))
    }
    @Test fun staleAndFastFixesDroppedWithoutSequenceConsumption() {
        val gate = CompanionFixGate(); val fix = CompanionFix(1.0, 2.0, 5.0, 100_000)
        assertNull(gate.next(fix, 0, 120_000))
        assertEquals(1, JSONObject(gate.next(fix, 0, 100_000)!!).getInt("sequence"))
        assertNull(gate.next(fix, 500, 100_000)); assertNull(gate.next(fix, -1, 100_000))
        assertEquals(2, JSONObject(gate.next(fix, 1000, 100_000)!!).getInt("sequence"))
    }
}
