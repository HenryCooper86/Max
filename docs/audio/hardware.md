# Hardware guide: microphones, speakers and audio chips

For people putting a Max assistant into a helmet, a pair of glasses or a
headset. It covers what to build, what to buy, and how each choice connects
to the kit.

**How far to trust this page.** The parts of it about the kit are measured or
read from our own code. The parts about chips come from vendor pages, and
each row says how well we could confirm it. The acoustic advice is common
practice with sources where we found them; where we found none, it says so.
Nothing here replaces a datasheet, or an hour with the
[test bench](test-bench.md).

## Start with the speaker, not the microphone

The hardest problem in a worn voice device is the assistant hearing itself.
How much of the speaker reaches the microphone decides how much echo
cancellation you need, and that is set by the speaker type before anything
else.

| Speaker                                                                      | In the [contract](contract.md) | Echo at the microphone                                                                    | What it asks of the device                                                 |
| ---------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Sealed in the ear, or a closed cup over it                                   | `sealed`                       | Very little: the seal keeps the sound in.                                                 | Echo cancellation is still worth having, but a device can work without it. |
| Open near the ear: glasses temples, helmet cheek-pad speakers, open-ear buds | `open`                         | A lot. Nothing stops the sound reaching the microphones.                                  | Echo cancellation is required for the wearer to interrupt the assistant.   |
| Bone conduction                                                              | `bone`                         | Some: it also radiates sound into the air, and vibrates the frame the microphones sit in. | Treat as `open` until you have measured it.                                |
| Loudspeaker                                                                  | `loudspeaker`                  | The most.                                                                                 | Strong echo cancellation, and a canceller that is given the played signal. |

Research on smart glasses names a very poor signal-to-echo ratio as a central
problem for open-ear designs
([Interspeech 2025](https://www.isca-archive.org/interspeech_2025/lin25b_interspeech.pdf);
we read the abstract-level description, not the full paper). We found no
published measurements for helmet cheek-pad speakers or bone conduction, so
the rows above for those are reasoning, not data. Measure yours with the
bench's echo test.

**An echo canceller needs the played signal.** It subtracts what the speaker
played from what the microphone heard, so it must be handed the speaker
signal, as late in the chain as possible (after volume and any limiter), and
with a short, steady delay between the two. A long or varying playback buffer
puts the echo out of its reach. The RDK board client keeps 80 ms queued for
this reason.

## Microphones

### How many, and where

- **One microphone on a boom, near the mouth.** The classic helmet intercom
  layout. Closeness does the work: the voice is far louder than everything
  else at the microphone. It needs no array processing. It does need a foam
  cover and a place out of the airflow.
- **Two microphones in a line pointing at the mouth** (an endfire pair). The
  usual choice for glasses temples and earbuds, where a boom is not an
  option. A DSP compares the two signals to favour sound from the mouth's
  direction. A first-order pair attenuates sound from the side by about 6 dB
  ([VOCAL](https://vocal.com/beamforming-2/endfire-microphone-array-beamforming/));
  TDK InvenSense's application note AN-1140 describes both endfire and
  broadside arrays
  ([PDF](https://www.mouser.lt/pdfDocs/Microphone-Array-Beamforming-3.pdf)).
  Spacing trades how much the pair rejects against the highest frequency it
  works at. **We could not confirm a spacing figure for wearables from a
  source we read**: use your DSP vendor's reference design.
- **Three or four microphones.** Used when the device should also find where
  a sound came from, or reject noise from several directions. The array chips
  below take up to four.

More microphones only help if something uses them. Two microphones wired to a
codec with no beamformer are one microphone and a spare.

### What to look for in the part

- **Acoustic overload point (AOP).** The loudness at which the microphone
  distorts badly. Wind and engines are loud at low frequencies, and a
  microphone driven past its AOP cannot be repaired by filtering afterwards.
  One trade article puts wind above 120 dB SPL and calls a 130 dB SPL AOP the
  current minimum, with older parts at 120
  ([eeNews Europe](https://www.eenewseurope.com/en/mems-microphone-design-for-better-audio/)).
  For a helmet, prefer the highest AOP you can get.
- **Signal-to-noise ratio (SNR).** The microphone's own hiss, measured
  against a 94 dB SPL tone. Higher is better, and matters most for a
  microphone far from the mouth. We found no sourced minimum for speech
  recognition.
- **Sample rate.** The kit takes 16 kHz. The two voice DSPs we could check
  (XMOS and Espressif, below) process at 16 kHz as well.

### Wind

Wind noise is turbulence at the microphone's opening. It is strongest at low
frequencies, and it is not sound, so two microphones a few millimetres apart
do not hear the same thing.

What helps, in rough order:

1. **Keep the opening out of the airflow.** Behind a lip, inside the chin
   bar, on the trailing side of a temple.
2. **Cover it.** An acoustic mesh or open-cell foam slows the air at the
   opening. Simulation work by Sonos found a mesh cut wind-induced
   fluctuation substantially, and that the shape of the opening mattered less
   ([COMSOL](https://www.comsol.com/blogs/sonos-optimizes-mems-microphone-design-to-reduce-distortion-from-wind-noise)).
3. **Round the edges nearby.** Knowles' application note AN-21 recommends
   radii over 2 mm, preferably 4 mm, on housing edges the wind meets
   ([PDF](https://www.knowles.com/docs/default-source/default-document-library/an-21-microphone-wind-noise.pdf);
   we could not open the PDF and have this from an index excerpt).
4. **Filter the low end.** A high-pass filter removes much of what is left.
   It does nothing about turbulence, and nothing once the microphone has
   overloaded.

The kit's "Helmet · wind" equaliser preset shapes the assistant's **voice**
so it is easier to hear over wind. It does not touch the microphone.

## Audio chips

What each does on the chip or in its vendor library, so you know what to
declare in the contract. **Confirmed** means we read it on the vendor's own
page. **Excerpt** means we saw it quoted in search results but could not open
the page. **Unconfirmed** means we could not establish it either way.

| Part                                                                                                                                           | Echo cancellation                                                                    | Noise suppression                                             | Microphones and beamforming                          | Speech detection, wake word                      | In and out                                                                          | How sure                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------- |
| [XMOS XVF3800](https://www.xmos.com/documentation/XM-014888-PC/html/modules/fwk_xvf/doc/datasheet/03_audio_pipeline.html)                      | Yes, per microphone. The played signal must arrive on the left channel of its input. | Yes, "up to 25 dB, depending on input SNR", plus gain control | 4 PDM microphones, three beams, direction of arrival | Neither stated                                   | I2S or USB (chosen when the firmware is built), 16 or 48 kHz                        | Confirmed                           |
| [Espressif ESP32-S3 with the ESP-SR audio front end](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/audio_front_end/README.html) | Yes, up to two microphones                                                           | Yes, single channel, aimed at steady noise; gain control      | Up to 2, with source separation                      | Both: voice detection, and the WakeNet wake word | A software library: microphones and the played signal come in over I2S from a codec | Confirmed                           |
| [Seeed ReSpeaker XVF3800 array](https://wiki.seeedstudio.com/respeaker_xvf3800_introduction/)                                                  | Yes                                                                                  | Yes, with gain control and de-reverberation                   | 4 microphones in a circle, direction of arrival      | Voice activity data; no wake word                | USB audio (plug and play), or I2S with different firmware; speaker output on board  | Confirmed                           |
| [Seeed ReSpeaker Mic Array v2.0](https://www.seeedstudio.com/ReSpeaker-Mic-Array-v2-0.html)                                                    | Yes                                                                                  | Yes, with gain control                                        | 4 microphones (XMOS XVF3000)                         | No wake word                                     | USB audio, 16 kHz at most                                                           | Confirmed                           |
| [Knowles AISonic IA8201](https://www.digikey.at/en/product-highlight/k/knowles/ia8201-audio-edge-processor)                                    | Described by Knowles as a target use; not on the page we read                        | Noise reduction listed                                        | Up to 4 PDM microphones                              | Wake-on-voice with low-power keyword listening   | SPI, I2C, UART, PCM/TDM                                                             | Confirmed, except echo cancellation |
| Qualcomm QCC30xx and QCC51xx Bluetooth audio chips                                                                                             | Described as "cVc" echo cancellation and noise suppression                           | Same                                                          | Up to 3 microphones on some parts                    | Unconfirmed                                      | Bluetooth; several parts are marked not for new designs                             | Excerpt                             |
| Bestechnic BES2500, 2600, 2700                                                                                                                 | Unconfirmed                                                                          | Unconfirmed                                                   | Unconfirmed                                          | Unconfirmed                                      | Bluetooth; described with noise cancelling for the ear                              | Excerpt                             |
| Airoha AB156x, AB158x                                                                                                                          | Unconfirmed                                                                          | Unconfirmed                                                   | Unconfirmed                                          | Unconfirmed                                      | Bluetooth with LE Audio                                                             | Excerpt                             |
| Realtek RTL8763E, RTL8773E                                                                                                                     | Unconfirmed                                                                          | Unconfirmed                                                   | Unconfirmed                                          | Unconfirmed                                      | Bluetooth with LE Audio                                                             | Excerpt                             |
| [Analog Devices ADAU1787](https://www.analog.com/en/products/adau1787.html)                                                                    | Unconfirmed                                                                          | Unconfirmed                                                   | 8 digital and 4 analog microphone inputs             | Unconfirmed                                      | A codec for noise cancelling at the ear                                             | Excerpt                             |

Two cautions on reading that table:

- **Noise cancelling for the ear (ANC) is not noise suppression for the
  microphone.** ANC makes the world quieter for the wearer. It does nothing
  for what the assistant hears. The Bluetooth earbud chips advertise ANC
  prominently; whether their microphone-side processing suits your product is
  a separate question for the datasheet.
- **We could not identify the chips inside motorcycle intercoms** such as
  Sena or Cardo from any source we trust.

A Raspberry Pi has no microphone input of its own. Add a USB device, an I2S
microphone, or a codec board. Echo cancellation on a Pi is done in software
or by the add-on board; we found no source saying the Pi provides any.

## Wiring it to the kit

Three shapes of product, and what each needs.

### A board running Linux

A Raspberry Pi, an RDK, or similar, with a microphone array that does its own
processing (the XMOS-based boards above present as an ordinary USB sound
card).

- Run [`examples/device-client/max_device.py`](../../examples/device-client/max_device.py),
  or use it as the pattern for your own client.
- Declare what the array does: `--aec yes --ns yes --agc yes --microphones 4`.
- If the microphones are plain (an I2S microphone, a codec board), the board
  must cancel echo itself or declare that it does not. Our RDK X5 client is
  the worked example of doing it in software: WebRTC audio processing fed
  with the played signal. Its notes on what did and did not work are in
  [`rdk/README.md`](../../rdk/README.md).

### A microcontroller

An ESP32-S3 with Espressif's audio front end, or a voice DSP beside a small
radio chip.

- The firmware speaks the same protocol directly: one WebSocket, JSON for
  events, binary for audio. The reference client is a few hundred lines and is
  meant to be ported. We do not ship firmware for a microcontroller.
- This is where `voiceGate` and `wakeWord` earn their place. A device that
  detects speech and its wake word on the chip can stay off the network until
  it is addressed. Declare both, and the relay fills the silence and skips
  its own name check.
- The relay sends voice at 24 kHz. A chip whose output runs at 16 or 48 kHz
  resamples on the device.

### A Bluetooth headset with a phone

The headset is a Bluetooth audio device and the Max iOS or Android app is the
client.

- The headset's chip handles its own microphones and, if it has it, ear noise
  cancelling. The phone adds the platform's echo cancellation and noise
  suppression on top.
- Nothing to build on the kit side. The phone apps do not send an `audio`
  declaration yet, so the relay treats them as it always has.
- Bluetooth's call profile narrows the audio and adds delay. LE Audio is
  better on both counts where the chip and the phone support it.

## Delay

Every stage adds some, and the wearer hears the total as the pause before the
assistant answers.

- The usual reference for conversation is ITU-T G.114, commonly quoted as
  recommending under 150 ms one way and no more than 400 ms
  ([the recommendation](https://www.itu.int/rec/T-REC-G.114-200305-I/en); we
  could not open its text to check the wording, so treat the figures as
  commonly cited, not confirmed).
- What a device controls: the capture frame (20 ms), any DSP look-ahead, the
  playback buffer, and Bluetooth if it is in the path.
- What it does not: the network and the voice model, which are far larger.

Keep the device's share small and steady. A steady delay is one an echo
canceller can track; a delay that wanders is not.

## Before blaming the software

1. Record the microphone, after its processing, with someone speaking at
   arm's length in a quiet room. If it is quiet, clipped or muffled there,
   fix that first.
2. Run the [test bench](test-bench.md) echo test. If the echo is taken for
   the wearer, no setting in the relay will stop the assistant cutting itself
   off.
3. Run the bench's noise recordings through the device. Compare with the
   software baseline.
4. Check the relay's log for `device audio declared`: it shows what the
   device said and what the relay decided.
