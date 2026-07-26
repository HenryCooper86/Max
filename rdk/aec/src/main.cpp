#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "apm.h"
#include "resample.h"
#include "wav.h"

namespace {

int run_offline(const std::string& ref_path, const std::string& mic_path,
                const std::string& out_path, int delay_ms, int suppression) {
  int ref_rate = 0, mic_rate = 0;
  std::vector<int16_t> ref, mic;
  if (!wav_read_mono16(ref_path, ref_rate, ref)) {
    std::fprintf(stderr, "max-aec: cannot read %s\n", ref_path.c_str());
    return 1;
  }
  if (!wav_read_mono16(mic_path, mic_rate, mic)) {
    std::fprintf(stderr, "max-aec: cannot read %s\n", mic_path.c_str());
    return 1;
  }

  Decimator3 ref_dec, mic_dec;
  std::vector<int16_t> ref16 = ref_rate == 48000 ? ref_dec.process(ref.data(), ref.size()) : ref;
  std::vector<int16_t> mic16 = mic_rate == 48000 ? mic_dec.process(mic.data(), mic.size()) : mic;

  ApmSession apm;
  if (!apm.init(delay_ms, suppression)) {
    std::fprintf(stderr, "max-aec: APM init failed\n");
    return 1;
  }

  std::vector<int16_t> out;
  out.reserve(mic16.size());
  const size_t frame = ApmSession::kFrameSamples;
  std::vector<int16_t> block(frame);
  for (size_t i = 0; i + frame <= mic16.size(); i += frame) {
    if (i + frame <= ref16.size()) apm.process_reverse(&ref16[i]);
    std::memcpy(block.data(), &mic16[i], frame * sizeof(int16_t));
    apm.process(block.data());
    out.insert(out.end(), block.begin(), block.end());
  }

  if (!wav_write_mono16(out_path, 16000, out)) {
    std::fprintf(stderr, "max-aec: cannot write %s\n", out_path.c_str());
    return 1;
  }
  std::fprintf(stderr, "max-aec: offline done, %zu frames, erle %.1f dB\n", out.size() / frame,
               static_cast<double>(apm.erle_db()));
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  int delay_ms = 160;
  int suppression = 0;
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--delay-ms") == 0 && i + 1 < argc) delay_ms = std::atoi(argv[++i]);
    if (std::strcmp(argv[i], "--suppression") == 0 && i + 1 < argc)
      suppression = std::atoi(argv[++i]);
  }
  if (argc >= 5 && std::strcmp(argv[1], "--offline") == 0) {
    return run_offline(argv[2], argv[3], argv[4], delay_ms, suppression);
  }
  std::fprintf(stderr,
               "usage: max-aec --offline <ref.wav> <mic.wav> <out.wav> [--delay-ms N] "
               "[--suppression 0|1|2]\n"
               "       max-aec --device <alsa> [--delay-ms N]   (live: mic->stdout, ref on fd 3)\n");
  return 2;
}
