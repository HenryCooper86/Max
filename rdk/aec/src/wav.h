#pragma once
#include <cstdint>
#include <string>
#include <vector>

// Minimal 16-bit mono PCM WAV. Offline mode only — the live path is raw PCM.
bool wav_read_mono16(const std::string& path, int& rate, std::vector<int16_t>& out);
bool wav_write_mono16(const std::string& path, int rate, const std::vector<int16_t>& in);
