#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

// 48 kHz -> 16 kHz, mirroring createDecimator(3, LOW_PASS_48K) in
// rdk/agent/src/audio/dsp.ts. Both legs of the canceller must be decimated
// identically; a mismatch between mic and reference presents as echo.
class Decimator3 {
 public:
  Decimator3();
  std::vector<int16_t> process(const int16_t* in, size_t n);

 private:
  std::vector<float> taps_;
  std::vector<float> history_;
  int phase_ = 0;
};
