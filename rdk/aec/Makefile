# max-aec — echo cancellation helper for the RDK X5 helmet client.
# Build on the board: apt install libwebrtc-audio-processing-dev libasound2-dev
CXX      ?= g++
CXXFLAGS ?= -O2 -std=c++14 -Wall -Wextra
PKGS      = webrtc-audio-processing alsa
CXXFLAGS += $(shell pkg-config --cflags $(PKGS))
LDLIBS    = $(shell pkg-config --libs $(PKGS))

SRC = src/main.cpp src/resample.cpp src/wav.cpp src/apm.cpp
BIN = max-aec

$(BIN): $(SRC)
	$(CXX) $(CXXFLAGS) -o $@ $(SRC) $(LDLIBS)

clean:
	rm -f $(BIN)

.PHONY: clean
