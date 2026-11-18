import { useEffect, useState } from "react";
import hummingbirdMark from "../../brand/hummingbird.svg?url";
import { applyBrandFavicon, resolveAssistant } from "../lib/assistant";
import { fetchAgentHealth } from "../lib/utils";

/**
 * The logo beside the name in the site header, shared by the public pages and
 * the Max Cloud console: the relay's logo (the owner's own, or Max's
 * hummingbird), and the hummingbird itself while that loads or if it fails.
 */
export function SiteMark({ logoUrl }: { logoUrl?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = logoUrl && failedUrl !== logoUrl ? logoUrl : hummingbirdMark;
  return (
    <img
      className="brandLogo siteLogo"
      src={src}
      alt=""
      decoding="async"
      draggable={false}
      onError={() => {
        if (logoUrl) setFailedUrl(logoUrl);
      }}
    />
  );
}

/** The relay's logo for the header, also set as the page's favicon. */
export function useSiteLogo(): { logoUrl?: string; developer?: string } {
  const [state, setState] = useState<{ logoUrl?: string; developer?: string }>({});
  useEffect(() => {
    let active = true;
    void fetchAgentHealth().then((health) => {
      if (!active) return;
      const logoUrl = resolveAssistant(health?.assistant ?? null).logoUrl;
      setState({ logoUrl, developer: health?.assistant?.developer });
      applyBrandFavicon(document, logoUrl);
    });
    return () => {
      active = false;
    };
  }, []);
  return state;
}
