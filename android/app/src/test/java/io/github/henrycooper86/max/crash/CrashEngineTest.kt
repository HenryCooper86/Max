package io.github.henrycooper86.max.crash
import org.junit.Assert.*
import org.junit.Test

class CrashEngineTest {
    @Test fun speedAndSustainedImpactPromote() {
        var s = CrashEngine.step(CrashState(), CrashSample(0.0, 5.0, 0.0, 20.0)).state
        s = CrashEngine.step(s, CrashSample(.03, 5.0, 0.0, 20.0)).state
        assertEquals(CrashPhase.CANDIDATE, s.phase); assertEquals(20.0, s.peakSpeed!!, 0.0)
        val u = CrashEngine.step(s, CrashSample(.6, 5.0, 0.0, 0.0))
        assertEquals(CrashPhase.CHECK_IN, u.state.phase); assertEquals(listOf(CrashEffect.CHECK_IN), u.effects)
    }
    @Test fun slowSingleImpactDoesNotPromote() {
        var s = CrashState()
        repeat(20) { s = CrashEngine.step(s, CrashSample(it / 100.0, 5.0, 0.0, 1.0)).state }
        assertEquals(CrashPhase.ARMED, s.phase)
    }
    @Test fun combinedImpactAndTumblePromoteWithoutSpeed() {
        var s = CrashState()
        repeat(20) { s = CrashEngine.step(s, CrashSample(it / 100.0, 5.0, 7.0)).state }
        assertEquals(CrashPhase.CANDIDATE, s.phase)
    }
    @Test fun isolatedSpikeAndInvalidSamplesAreIgnored() {
        var s = CrashEngine.step(CrashState(), CrashSample(1.0, 6.0, 0.0, 20.0)).state
        s = CrashEngine.step(s, CrashSample(1.01, 0.0, 0.0, 20.0)).state
        assertEquals(CrashPhase.ARMED, s.phase)
        assertEquals(s, CrashEngine.step(s, CrashSample(Double.NaN, 5.0, 0.0)).state)
        assertEquals(s, CrashEngine.step(s, CrashSample(.9, 5.0, 0.0)).state)
    }
    @Test fun stationaryTraceConfirmsAndMovingTraceTimesOut() {
        var s = CrashState(CrashPhase.CANDIDATE, since = 0.0, peakSpeed = 30.0)
        repeat(110) { s = CrashEngine.step(s, CrashSample(it / 100.0, .01, 0.0, 0.0)).state }
        assertEquals(CrashPhase.CHECK_IN, s.phase)
        val timeout = CrashEngine.tick(CrashState(CrashPhase.CANDIDATE), 5.0)
        assertEquals(CrashPhase.ARMED, timeout.state.phase)
    }
    @Test fun gateSpeedOpensTheGateButNeverVetoesStillness() {
        var s = CrashEngine.step(CrashState(), CrashSample(0.0, 5.0, 0.0, speed = null, gateSpeed = 60.0)).state
        s = CrashEngine.step(s, CrashSample(.03, 5.0, 0.0, speed = null, gateSpeed = 60.0)).state
        assertEquals(CrashPhase.CANDIDATE, s.phase); assertEquals(60.0, s.peakSpeed!!, 0.0)
        // The tunnel's remembered 60 km/h keeps arriving as a gate speed while the bike lies still.
        repeat(110) { s = CrashEngine.step(s, CrashSample(.04 + it / 100.0, .01, 0.0, speed = null, gateSpeed = 60.0)).state }
        assertEquals(CrashPhase.CHECK_IN, s.phase)
    }
    @Test fun invalidGateSpeedIsIgnored() {
        var s = CrashState()
        repeat(5) { s = CrashEngine.step(s, CrashSample(it / 100.0, 5.0, 0.0, speed = null, gateSpeed = Double.NaN)).state }
        assertEquals(CrashPhase.ARMED, s.phase)
        repeat(5) { s = CrashEngine.step(s, CrashSample(.1 + it / 100.0, 5.0, 0.0, speed = null, gateSpeed = -20.0)).state }
        assertEquals(CrashPhase.ARMED, s.phase)
    }
    @Test fun countdownAndCancellationAreOneShot() {
        var s = CrashEngine.simulate(CrashState(), 0.0).state
        assertEquals(CrashPhase.CHECK_IN, CrashEngine.tick(s, 14.9).state.phase)
        s = CrashEngine.tick(s, 15.0).state
        assertEquals(CrashPhase.ALARM, s.phase)
        s = CrashEngine.tick(s, 45.0).state
        assertEquals(CrashPhase.ESCALATED, s.phase)
        assertTrue(CrashEngine.tick(s, 60.0).effects.isEmpty())
        assertTrue(CrashEngine.cancel(s).effects.contains(CrashEffect.CANCEL))
        assertTrue(CrashEngine.cancel(CrashState(CrashPhase.ALARM)).effects.contains(CrashEffect.NEAR_MISS))
    }
}
