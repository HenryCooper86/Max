package com.horizon.maxhelmet.crash
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CrashControllerTest {
    private class Harness {
        var time = 0.0
        var config = CrashSettings()
        val sent = mutableListOf<String>()
        val alarms = mutableListOf<Boolean>()
        var location: ((Pair<Double, Double>?) -> Unit)? = null
        var ui = CrashUi()
        var resolved = 0
        val c = CrashController({ time }, { 123456L }, { config }, { location = it }, {}, { alarms.add(it) }, { sent.add(it) }, { ui = it }, { resolved++ })
        fun realIncident() {
            c.arm(); c.sample(CrashSample(0.0, 5.0, 0.0, 25.0)); c.sample(CrashSample(.03, 5.0, 0.0, 25.0))
            time = .6; c.sample(CrashSample(time, 5.0, 0.0, 0.0))
        }
        fun escalate() { time += 15; c.tick(); time += 30; c.tick() }
    }
    @Test fun cancellationWhileLocatingNeverSendsOrResendsAlert() {
        val h = Harness(); h.realIncident(); h.escalate(); h.c.cancel(); h.location?.invoke(1.0 to 2.0); h.c.ready()
        assertTrue(h.sent.none { JSONObject(it).getString("type") == "crash.alert" }); assertNull(h.c.pending); assertEquals(1, h.resolved)
    }
    @Test fun alertPreservesImpactSpeedAndOptInAndRetriesSameId() {
        val h = Harness(); h.config = CrashSettings("+8613800000000", true); h.realIncident(); h.escalate(); h.location?.invoke(1.0 to 2.0)
        val j = JSONObject(h.sent.single()); assertEquals(25.0, j.getDouble("speedKmhRecent"), 0.0); assertTrue(j.getBoolean("contactOptIn")); assertTrue(j.has("contactNumber"))
        h.c.ready(); assertEquals(h.sent[0], h.sent[1])
        h.c.ack("wrong", "notified", null); assertNotNull(h.c.pending)
        h.c.ack(j.getString("incidentId"), "notified", null); assertNull(h.c.pending)
        h.c.ready(); assertEquals(2, h.sent.size)
    }
    @Test fun noOptInOmitsContactAndNoAckIsHonest() {
        val h = Harness(); h.config = CrashSettings("+8613800000000", false); h.realIncident(); h.escalate(); h.location?.invoke(null)
        assertFalse(JSONObject(h.sent.single()).has("contactNumber")); h.time += 10; h.c.tick(); assertTrue(h.ui.message!!.contains("未确认"))
    }
    @Test fun incidentSurvivesSessionEndAndAccountDetachBlocksLateLocation() {
        val h = Harness(); h.realIncident(); h.c.sessionEnded(); h.escalate(); assertTrue(h.alarms.contains(true))
        h.c.detachAccount(); h.c.arm(); h.location?.invoke(null); h.c.ready(); assertTrue(h.sent.isEmpty()); assertTrue(h.c.active)
        h.c.cancel(); assertEquals(false, h.alarms.last())
    }
    @Test fun simulationNeverSendsEvenWithOptIn() {
        val h = Harness(); h.config = CrashSettings("+8613800000000", true); h.c.arm(); h.c.simulate(); h.escalate(); h.c.cancel(); assertTrue(h.sent.isEmpty()); assertNull(h.location)
    }
    @Test fun logOnlySuppressesAndVoiceCancels() {
        val h = Harness(); h.config = CrashSettings(logOnly = true); h.realIncident(); assertFalse(h.c.active)
        h.config = CrashSettings(); h.c.simulate(); h.c.transcript("我没事"); assertFalse(h.c.active)
    }
    @Test fun unknownAckCannotClaimSuccess() {
        val h = Harness(); h.realIncident(); h.escalate(); h.location?.invoke(null)
        h.c.ack(h.c.incidentId!!, "queued", null); assertNotNull(h.c.pending)
    }
}
