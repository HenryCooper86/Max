/**
 * What a phone carrier has to provide for the relay to hold calls on it.
 *
 * The call logic (tickets, sessions, transfers, keypad input, outbound calls)
 * is the same on every carrier and lives in twilio-calls.ts. A carrier is the
 * part that differs: how its webhooks are authenticated, the XML it takes, the
 * messages on its media stream, and its REST API.
 */

/** One message from a carrier's media stream, in the relay's own terms. */
export type CarrierMessage =
  | {
      event: "start";
      streamId: string;
      /** The call the stream belongs to, when the carrier says so in terms the voice webhook also used. */
      callId?: string;
      /** The ticket, when the carrier carries custom parameters in this message. */
      ticket?: string;
      /** Why this stream cannot be served (audio in a format the relay did not ask for). */
      unusable?: string;
    }
  | {
      event: "media";
      /** Base64 μ-law, 8 kHz. */
      payload: string;
      track?: string;
      /** The frame's number, on a carrier that does not promise to deliver frames in order. */
      sequence?: number;
    }
  | { event: "dtmf"; digit: string }
  | { event: "mark"; name: string }
  | { event: "stop" }
  /** The carrier reports a problem with the stream. For the log; the call carries on. */
  | { event: "problem"; detail: string };

/** Audio conversion and message framing for one call's media stream. */
export type CarrierBridge = {
  /** Caller audio: one media payload → whole 20 ms frames of PCM16 at 16 kHz. */
  inbound(payloadBase64: string, track?: string, sequence?: number): Buffer[];
  /** Assistant audio: PCM16 at 24 kHz → the carrier's media messages. */
  outbound(pcm24k: Buffer): string[];
  /** What is left over, padded to a whole frame. */
  flush(): string[];
  /** The message that makes the carrier drop the audio it has buffered. */
  clear(): string;
  /** A message the carrier echoes back when playback reaches this point. */
  mark(name: string): string;
};

export type Carrier = {
  /** In URLs: /telephony/<id>/voice and /telephony/<id>/stream. */
  id: "twilio" | "telnyx";
  /** In logs and messages. */
  label: string;
  validCallId(id: string): boolean;
  /** Whether a voice webhook really is the carrier's, for this account. */
  authentic(input: { url: string; params: Record<string, string>; signature: string | undefined }): boolean;
  /** The URL the carrier fetches an outbound call's instructions from. */
  voiceUrl(base: string, plan: string): string;
  /** The URL the carrier reports an outbound call's outcome to. Holds a secret exactly when the voice URL does. */
  statusUrl(base: string, plan: string): string;
  /**
   * Whether that URL holds a secret. It is then built only from the relay's
   * configured public address, never from the address a request came in on,
   * which whoever sent the request chooses.
   */
  voiceUrlIsSecret: boolean;
  /** XML that connects the call to the relay's media stream. */
  answerXml(streamUrl: string, ticket: string): string;
  /** XML that transfers the call to a phone number or SIP address. */
  dialXml(destination: string, options: { callerId?: string }): string;
  /**
   * Transfers that tell whoever picks up what the call is about, and bring
   * the caller back to the assistant when nobody takes it. Absent on a
   * carrier the relay cannot do this with.
   */
  warmTransfer?: {
    /** XML that dials, asks `whisperUrl` what the person who answers hears, and `actionUrl` what follows the dial. */
    dialXml(
      destination: string,
      options: { callerId?: string; whisperUrl: string; actionUrl: string; timeoutSeconds: number }
    ): string;
    /** XML for the person who picked up. With `confirm` a key must be pressed to take the call. */
    whisperXml(
      text: string | undefined,
      language: string | undefined,
      confirm?: { prompt: string; actionUrl: string }
    ): string;
    /** XML with nothing in it: the call goes on to what was next. */
    continueXml(): string;
  };
  /** XML that says an optional line and hangs up. */
  hangupXml(say?: string, language?: string): string;
  /** XML that turns the call away because every line is taken. */
  busyXml(): string;
  /** Parses one text message from the media stream. Undefined for anything it cannot use; never throws. */
  parse(raw: string): CarrierMessage | undefined;
  bridge(streamId: string): CarrierBridge;
  /** Whether the voice webhook of an outbound call says if a machine answered. */
  detectsMachines: boolean;
  /** Replaces a live call's instructions. Absent without the credentials for the carrier's REST API. */
  updateCall?(callId: string, xml: string): Promise<{ ok: boolean; status: number }>;
  /** Places a call that fetches its instructions from `url`. Absent without credentials. */
  placeCall?(input: {
    to: string;
    from: string;
    url: string;
    /** Where the carrier reports the call's final status, when someone is watching. */
    statusUrl?: string;
  }): Promise<{ ok: boolean; status: number; callId?: string }>;
  /** What to set to be able to place calls, for the error a caller of the API sees. */
  placeCallHelp: string;
};
