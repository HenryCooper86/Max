#include <alsa/asoundlib.h>
#include <fcntl.h>
#include <unistd.h>

#include <cerrno>
#include <cmath>
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
                const std::string& out_path, int delay_ms, int suppression,
                ApmStages stages) {
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
  if (!apm.init(delay_ms, suppression, stages)) {
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

// 48 kHz in, 16 kHz out. 960 input samples = 20 ms = one 320-sample uplink frame.
constexpr snd_pcm_uframes_t kPeriod = 960;

// Reference frame header: uint32 LE byte count, or 0 for "reset". Kept in step
// with createReferenceSink in rdk/agent/src/audio/reference.ts.
constexpr size_t kHeaderBytes = 4;

// Writes every byte or fails. A short write is not an error worth dying over:
// stdout is a pipe and SIGUSR-class signals interrupt it, which happens most
// often during barge-in — precisely when losing the uplink would be worst.
bool write_all(int fd, const void* data, size_t bytes) {
  const uint8_t* p = static_cast<const uint8_t*>(data);
  while (bytes > 0) {
    ssize_t n = write(fd, p, bytes);
    if (n > 0) {
      p += n;
      bytes -= static_cast<size_t>(n);
      continue;
    }
    if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    return false;
  }
  return true;
}

struct RefStats {
  long audio_frames = 0;
  long resets = 0;
  long samples = 0;
};

double frame_rms(const int16_t* pcm, size_t n) {
  double sum = 0.0;
  for (size_t i = 0; i < n; ++i) sum += static_cast<double>(pcm[i]) * pcm[i];
  return n == 0 ? 0.0 : std::sqrt(sum / static_cast<double>(n));
}

// Running level either side of APM. Reported separately for frames where Max
// was speaking and frames where he was not, because the echo loop is decided
// entirely by what leaves on the uplink while he speaks.
struct Levels {
  double in_sum = 0.0;
  double out_sum = 0.0;
  long count = 0;

  void add(double in, double out) {
    in_sum += in;
    out_sum += out;
    ++count;
  }
  double mean_in() const { return count ? in_sum / static_cast<double>(count) : 0.0; }
  double mean_out() const { return count ? out_sum / static_cast<double>(count) : 0.0; }
  double reduction_db() const {
    if (!count || mean_out() <= 0.0 || mean_in() <= 0.0) return 0.0;
    return 20.0 * std::log10(mean_in() / mean_out());
  }
  void reset() { in_sum = out_sum = 0.0, count = 0; }
};

// 10 ms per frame, so this reports roughly every 3 s.
constexpr long kReportFrames = 300;

// Pulls whatever the agent has queued and turns it into 16 kHz reference,
// applying resets in the order they were sent. Returns false when the agent has
// closed the pipe, which means it is gone and so should we.
bool drain_reference(std::vector<uint8_t>& rx, size_t& rx_read, Decimator3& ref_dec,
                     std::vector<int16_t>& pending, size_t& pending_read, ApmSession& apm,
                     RefStats& stats) {
  uint8_t buf[4096];
  for (;;) {
    ssize_t got = read(3, buf, sizeof(buf));
    if (got > 0) {
      rx.insert(rx.end(), buf, buf + got);
      continue;
    }
    if (got == 0) return false;                  // agent closed the pipe
    if (errno == EINTR) continue;                // barge-in signal, not an error
    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
    return false;
  }

  // Whole frames only. A partial frame stays buffered; consuming half a sample
  // would shift every byte after it and silently corrupt the reference forever.
  for (;;) {
    const size_t available = rx.size() - rx_read;
    if (available < kHeaderBytes) break;
    uint32_t length = 0;
    std::memcpy(&length, rx.data() + rx_read, kHeaderBytes);

    if (length == 0) {
      rx_read += kHeaderBytes;
      // Barge-in: this audio was dropped before it reached the speaker. APM must
      // forget it, or it spends the rider's next words subtracting an echo that
      // never arrived.
      apm.reset();
      pending.clear();
      pending_read = 0;
      ref_dec = Decimator3();  // filter history belongs to audio that never played
      ++stats.resets;
      continue;
    }

    if (available < kHeaderBytes + length) break;
    const uint8_t* payload = rx.data() + rx_read + kHeaderBytes;
    std::vector<int16_t> samples(length / sizeof(int16_t));
    std::memcpy(samples.data(), payload, samples.size() * sizeof(int16_t));
    std::vector<int16_t> down = ref_dec.process(samples.data(), samples.size());
    pending.insert(pending.end(), down.begin(), down.end());
    rx_read += kHeaderBytes + length;
    ++stats.audio_frames;
    stats.samples += static_cast<long>(down.size());
  }

  if (rx_read > 0) {
    rx.erase(rx.begin(), rx.begin() + static_cast<long>(rx_read));
    rx_read = 0;
  }
  return true;
}

int run_live(const std::string& device, int delay_ms, int suppression,
             ApmStages stages) {
  int flags = fcntl(3, F_GETFL, 0);
  if (flags >= 0) fcntl(3, F_SETFL, flags | O_NONBLOCK);

  snd_pcm_t* pcm = nullptr;
  if (snd_pcm_open(&pcm, device.c_str(), SND_PCM_STREAM_CAPTURE, 0) < 0) {
    std::fprintf(stderr, "max-aec: cannot open %s\n", device.c_str());
    return 1;
  }
  if (snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 1, 48000, 1,
                         200000) < 0) {
    std::fprintf(stderr, "max-aec: cannot configure %s\n", device.c_str());
    snd_pcm_close(pcm);
    return 1;
  }

  ApmSession apm;
  if (!apm.init(delay_ms, suppression, stages)) {
    std::fprintf(stderr, "max-aec: APM init failed\n");
    snd_pcm_close(pcm);
    return 1;
  }

  Decimator3 mic_dec, ref_dec;
  std::vector<uint8_t> rx;
  size_t rx_read = 0;
  // Reference consumed one frame per mic frame, so any backlog is just the
  // relay running ahead of the speaker. It drains at realtime and its size is
  // the delay we hint to APM, so an index beats erase-from-front here.
  std::vector<int16_t> pending;
  size_t pending_read = 0;
  std::vector<int16_t> mic_in(kPeriod);
  RefStats stats;
  long mic_frames = 0;
  long last_report = 0;
  long reported_resets = 0;
  Levels far, near;

  for (;;) {
    if (!drain_reference(rx, rx_read, ref_dec, pending, pending_read, apm, stats)) break;

    snd_pcm_sframes_t read_frames = snd_pcm_readi(pcm, mic_in.data(), kPeriod);
    if (read_frames < 0) {
      if (snd_pcm_recover(pcm, static_cast<int>(read_frames), 1) < 0) break;
      continue;
    }

    std::vector<int16_t> mic16 = mic_dec.process(mic_in.data(), static_cast<size_t>(read_frames));
    const size_t frame = ApmSession::kFrameSamples;
    for (size_t i = 0; i + frame <= mic16.size(); i += frame) {
      const bool had_reference = pending.size() - pending_read >= frame;
      if (had_reference) {
        apm.process_reverse(pending.data() + pending_read);
        pending_read += frame;
      }
      const double before = frame_rms(&mic16[i], frame);
      apm.process(&mic16[i]);
      const double after = frame_rms(&mic16[i], frame);
      ++mic_frames;
      // Split by whether Max was speaking. Averaging across both hides the only
      // interesting case: what the uplink carries while he talks.
      if (had_reference) {
        far.add(before, after);
      } else {
        near.add(before, after);
      }
    }

    // Only speak up when there is something to report: an utterance that was
    // cancelled, or a reset. A helmet runs for hours and a line every 3 s of
    // silence would bury the one line that matters. The figures below are how
    // the 2026-07-26 echo loop was diagnosed — keep them.
    const bool worth_reporting = far.count > 0 || stats.resets != reported_resets;
    if (mic_frames - last_report >= kReportFrames && worth_reporting) {
      last_report = mic_frames;
      reported_resets = stats.resets;
      std::fprintf(stderr,
                   "max-aec: far-end %ld frames in=%.0f out=%.0f (%.1f dB removed) | "
                   "quiet %ld frames in=%.0f out=%.0f | ref %ld resets %ld erle %.1f dB\n",
                   far.count, far.mean_in(), far.mean_out(), far.reduction_db(), near.count,
                   near.mean_in(), near.mean_out(), stats.audio_frames, stats.resets,
                   static_cast<double>(apm.erle_db()));
      far.reset();
      near.reset();
    } else if (mic_frames - last_report >= kReportFrames) {
      last_report = mic_frames;
      far.reset();
      near.reset();
    }
    if (pending_read > 0) {
      pending.erase(pending.begin(), pending.begin() + static_cast<long>(pending_read));
      pending_read = 0;
    }

    if (!mic16.empty() &&
        !write_all(STDOUT_FILENO, mic16.data(), mic16.size() * sizeof(int16_t))) {
      break;
    }
  }

  // Without this, a reference pipe that was silently dropping every frame looks
  // exactly like one that worked: the output is mic audio either way.
  std::fprintf(stderr,
               "max-aec: exit — mic frames %ld, reference frames %ld (%ld samples), resets %ld, "
               "erle %.1f dB\n",
               mic_frames, stats.audio_frames, stats.samples, stats.resets,
               static_cast<double>(apm.erle_db()));

  snd_pcm_close(pcm);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  int delay_ms = 160;
  int suppression = 0;
  const char* device = nullptr;
  ApmStages stages;
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--delay-ms") == 0 && i + 1 < argc) delay_ms = std::atoi(argv[++i]);
    else if (std::strcmp(argv[i], "--suppression") == 0 && i + 1 < argc)
      suppression = std::atoi(argv[++i]);
    else if (std::strcmp(argv[i], "--device") == 0 && i + 1 < argc)
      device = argv[++i];
    else if (std::strcmp(argv[i], "--no-aec") == 0) stages.aec = false;
    else if (std::strcmp(argv[i], "--no-ns") == 0) stages.ns = false;
    else if (std::strcmp(argv[i], "--no-agc") == 0) stages.agc = false;
  }
  if (argc >= 5 && std::strcmp(argv[1], "--offline") == 0) {
    return run_offline(argv[2], argv[3], argv[4], delay_ms, suppression, stages);
  }
  if (device) return run_live(device, delay_ms, suppression, stages);
  std::fprintf(stderr,
               "usage: max-aec --offline <ref.wav> <mic.wav> <out.wav> [--delay-ms N] "
               "[--suppression 0|1|2]\n"
               "       max-aec --device <alsa> [--delay-ms N] [--suppression 0|1|2]\n"
               "         live: mic -> stdout as 16 kHz PCM16, reference frames on fd 3\n"
               "  [--no-aec] [--no-ns] [--no-agc]  disable a stage, for bench measurement\n");
  return 2;
}
