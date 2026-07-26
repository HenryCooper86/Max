#include "wav.h"

#include <cstdio>
#include <cstring>

namespace {
struct Header {
  char riff[4];
  uint32_t size;
  char wave[4];
  char fmt[4];
  uint32_t fmt_size;
  uint16_t format;
  uint16_t channels;
  uint32_t rate;
  uint32_t byte_rate;
  uint16_t block_align;
  uint16_t bits;
  char data[4];
  uint32_t data_size;
};
}  // namespace

bool wav_read_mono16(const std::string& path, int& rate, std::vector<int16_t>& out) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
  Header h{};
  if (std::fread(&h, sizeof(h), 1, f) != 1) {
    std::fclose(f);
    return false;
  }
  if (std::memcmp(h.riff, "RIFF", 4) != 0 || h.channels != 1 || h.bits != 16) {
    std::fclose(f);
    return false;
  }
  rate = static_cast<int>(h.rate);
  out.resize(h.data_size / 2);
  const size_t read = std::fread(out.data(), 2, out.size(), f);
  out.resize(read);
  std::fclose(f);
  return true;
}

bool wav_write_mono16(const std::string& path, int rate, const std::vector<int16_t>& in) {
  FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
  Header h{};
  std::memcpy(h.riff, "RIFF", 4);
  std::memcpy(h.wave, "WAVE", 4);
  std::memcpy(h.fmt, "fmt ", 4);
  std::memcpy(h.data, "data", 4);
  h.fmt_size = 16;
  h.format = 1;
  h.channels = 1;
  h.rate = static_cast<uint32_t>(rate);
  h.bits = 16;
  h.block_align = 2;
  h.byte_rate = h.rate * h.block_align;
  h.data_size = static_cast<uint32_t>(in.size() * 2);
  h.size = 36 + h.data_size;
  std::fwrite(&h, sizeof(h), 1, f);
  std::fwrite(in.data(), 2, in.size(), f);
  std::fclose(f);
  return true;
}
