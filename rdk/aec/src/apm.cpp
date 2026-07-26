#include "apm.h"

#include <webrtc/modules/audio_processing/include/audio_processing.h>
#include <webrtc/modules/interface/module_common_types.h>

#include <cstring>

using webrtc::AudioFrame;
using webrtc::AudioProcessing;

ApmSession::ApmSession() = default;

ApmSession::~ApmSession() {
  delete apm_;
}

bool ApmSession::init(int delay_ms, int suppression, ApmStages stages) {
  delay_ms_ = delay_ms;

  webrtc::Config config;
  // ExtendedFilter widens the adaptive filter; DelayAgnostic lets APM track the
  // real delay when our hint is wrong. Both matter because the aplay buffer
  // makes the true delay vary.
  config.Set<webrtc::ExtendedFilter>(new webrtc::ExtendedFilter(true));
  config.Set<webrtc::DelayAgnostic>(new webrtc::DelayAgnostic(true));

  apm_ = AudioProcessing::Create(config);
  if (!apm_) return false;

  if (apm_->Initialize(kRate, kRate, kRate, AudioProcessing::kMono, AudioProcessing::kMono,
                       AudioProcessing::kMono) != AudioProcessing::kNoError) {
    return false;
  }

  const webrtc::EchoCancellation::SuppressionLevel levels[] = {
      webrtc::EchoCancellation::kLowSuppression,
      webrtc::EchoCancellation::kModerateSuppression,
      webrtc::EchoCancellation::kHighSuppression,
  };
  if (suppression < 0) suppression = 0;
  if (suppression > 2) suppression = 2;
  apm_->echo_cancellation()->set_suppression_level(levels[suppression]);
  apm_->echo_cancellation()->enable_metrics(true);
  if (apm_->echo_cancellation()->Enable(stages.aec) != AudioProcessing::kNoError) return false;

  // The helmet wants these regardless of echo: wind and engine noise at speed.
  apm_->noise_suppression()->set_level(webrtc::NoiseSuppression::kHigh);
  apm_->noise_suppression()->Enable(stages.ns);
  apm_->gain_control()->set_mode(webrtc::GainControl::kAdaptiveDigital);
  apm_->gain_control()->Enable(stages.agc);

  return true;
}

namespace {
void fill(AudioFrame& frame, const int16_t* pcm) {
  frame.num_channels_ = 1;
  frame.sample_rate_hz_ = ApmSession::kRate;
  frame.samples_per_channel_ = ApmSession::kFrameSamples;
  std::memcpy(frame.data_, pcm, ApmSession::kFrameSamples * sizeof(int16_t));
}
}  // namespace

void ApmSession::process_reverse(const int16_t* ref) {
  if (!apm_) return;
  AudioFrame frame;
  fill(frame, ref);
  apm_->ProcessReverseStream(&frame);
}

void ApmSession::process(int16_t* mic) {
  if (!apm_) return;
  AudioFrame frame;
  fill(frame, mic);
  apm_->set_stream_delay_ms(delay_ms_);
  apm_->ProcessStream(&frame);
  std::memcpy(mic, frame.data_, kFrameSamples * sizeof(int16_t));

  webrtc::EchoCancellation::Metrics metrics;
  if (apm_->echo_cancellation()->GetMetrics(&metrics) == AudioProcessing::kNoError) {
    erle_db_ = static_cast<float>(metrics.echo_return_loss_enhancement.instant);
  }
}

void ApmSession::reset() {
  // Barge-in dropped reference audio that never played. Without this, APM keeps
  // adapting against an echo that will not arrive and damages the rider's speech.
  if (apm_) apm_->Initialize();
}

float ApmSession::erle_db() const {
  return erle_db_;
}
