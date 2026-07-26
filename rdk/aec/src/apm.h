#pragma once
#include <cstddef>
#include <cstdint>

namespace webrtc {
class AudioProcessing;
}

// Stages are individually switchable so the bench can attribute a result to one
// of them. Measuring with everything on is how you end up crediting the
// canceller for the gain control's work: AGC renormalises the output level, so
// residual RMS barely moves however much echo was actually removed.
struct ApmStages {
  bool aec = true;
  bool ns = true;
  bool agc = true;
};

// WebRTC APM at 16 kHz mono: echo cancellation, noise suppression, gain control.
// 16 kHz is the uplink rate, so nothing extra is converted on the path we send.
class ApmSession {
 public:
  // APM processes 10 ms frames: 160 samples at 16 kHz. One 320-sample uplink
  // frame is exactly two of these.
  static constexpr size_t kFrameSamples = 160;
  static constexpr int kRate = 16000;

  ApmSession();
  ~ApmSession();

  // suppression: 0 low, 1 moderate, 2 high. Defaults to HIGH.
  //
  // The offline fixture recommended 0: ERLE was identical at all three levels
  // (32.7 dB — the linear filter did the work) while double-talk loss climbed
  // 12.5 -> 16.7 -> 22.1 dB. That recommendation was wrong on real hardware,
  // and the caveat written beside it turned out to be the whole story: the
  // fixture's echo path is linear, a real speaker is not, and the nonlinear
  // residue is exactly what the residual suppressor exists to catch. On the
  // board the linear filter alone managed erle 0.0-2.0 dB and the echo loop
  // came back; suppression 2 stopped it. Confirmed live 2026-07-26.
  bool init(int delay_ms, int suppression = 2, ApmStages stages = ApmStages{});
  void process_reverse(const int16_t* ref);
  void process(int16_t* mic);
  void reset();
  float erle_db() const;

 private:
  webrtc::AudioProcessing* apm_ = nullptr;
  int delay_ms_ = 0;
  float erle_db_ = 0.0f;
};
