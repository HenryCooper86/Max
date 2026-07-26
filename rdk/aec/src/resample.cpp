#include "resample.h"

#include <cmath>

namespace {
constexpr int kTaps = 31;
constexpr double kCutoffHz = 7500.0;
constexpr double kRate = 48000.0;
constexpr int kFactor = 3;
}  // namespace

Decimator3::Decimator3() : taps_(kTaps), history_(kTaps - 1, 0.0f) {
  const double middle = (kTaps - 1) / 2.0;
  const double fc = kCutoffHz / kRate;
  double sum = 0.0;
  for (int i = 0; i < kTaps; ++i) {
    const double n = i - middle;
    const double sinc = (n == 0.0) ? 2.0 * fc : std::sin(2.0 * M_PI * fc * n) / (M_PI * n);
    const double window = 0.54 - 0.46 * std::cos(2.0 * M_PI * i / (kTaps - 1));
    taps_[i] = static_cast<float>(sinc * window);
    sum += taps_[i];
  }
  for (int i = 0; i < kTaps; ++i) taps_[i] = static_cast<float>(taps_[i] / sum);
}

std::vector<int16_t> Decimator3::process(const int16_t* in, size_t n) {
  const size_t width = taps_.size();
  std::vector<float> buffer(history_.size() + n);
  for (size_t i = 0; i < history_.size(); ++i) buffer[i] = history_[i];
  for (size_t i = 0; i < n; ++i) buffer[history_.size() + i] = in[i] / 32768.0f;

  std::vector<int16_t> out;
  out.reserve(n / kFactor + 1);
  for (size_t i = width - 1; i < buffer.size(); ++i) {
    if (phase_ == 0) {
      float acc = 0.0f;
      for (size_t k = 0; k < width; ++k) acc += taps_[k] * buffer[i - k];
      long scaled = std::lround(acc * 32768.0f);
      if (scaled > 32767) scaled = 32767;
      if (scaled < -32768) scaled = -32768;
      out.push_back(static_cast<int16_t>(scaled));
    }
    phase_ = (phase_ + 1) % kFactor;
  }

  history_.assign(buffer.end() - static_cast<long>(width - 1), buffer.end());
  return out;
}
