export type PacketWindow = {
  startedAt: number;
  sent: number;
  dropped: number;
};

export type PacketMetric = {
  outgoingFrames: number;
  outgoingFps: number;
  droppedFrames: number;
};

export function createPacketWindow(now = 0): PacketWindow {
  return { startedAt: now, sent: 0, dropped: 0 };
}

export function recordSentFrame(window: PacketWindow, now: number, intervalMs = 1000): { window: PacketWindow; metric?: PacketMetric } {
  const startedAt = window.startedAt || window.sent ? window.startedAt : now;
  const sent = window.sent + 1;
  const elapsed = now - startedAt;

  if (elapsed < intervalMs) {
    return { window: { ...window, startedAt, sent } };
  }

  return {
    window: { startedAt: now, sent: 0, dropped: window.dropped },
    metric: {
      outgoingFrames: sent,
      outgoingFps: Math.round((sent * 1000) / elapsed),
      droppedFrames: window.dropped
    }
  };
}

export function recordDroppedFrame(window: PacketWindow): { window: PacketWindow; metric: PacketMetric } {
  const dropped = window.dropped + 1;
  return {
    window: { ...window, dropped },
    metric: {
      outgoingFrames: window.sent,
      outgoingFps: 0,
      droppedFrames: dropped
    }
  };
}
