// Class list for the voice shell's root element.
//
// The landscape grid packs the readout, the caption panel, the utilities and
// the dock into a right-hand column beside the helmet, and hands one row the
// remaining space. With captions closed it collapses the `captions` row to
// zero — correct when that row really is empty, but the navigation panel
// occupies the same grid area, so a guidance card with captions closed was
// laid into a zero-height row and drawn over the controls beneath it.
//
// CSS has no way to ask whether a grid area is occupied, so the shell states
// it. Keeping this out of the JSX makes the rule testable on its own.

export type VoiceFaceState = {
  captionsOpen: boolean;
  navigationVisible: boolean;
};

export function voiceFaceClassName({ captionsOpen, navigationVisible }: VoiceFaceState): string {
  return ["voiceFace", captionsOpen ? "captionsVisible" : "", navigationVisible ? "navVisible" : ""]
    .filter(Boolean)
    .join(" ");
}
