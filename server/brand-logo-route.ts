import type { Response } from "express";
import type { BrandLogo } from "./assistant";

/**
 * Sends the assistant's logo.
 *
 * An SVG is served under a policy that lets it draw and nothing else, so a
 * logo file can never run script on the relay's origin.
 *
 * The file may live anywhere the owner put it, including under a directory
 * whose name starts with a dot: the Studio keeps an uploaded logo in
 * `~/.horizon-helmet-testing` by default, and Express refuses such paths
 * unless told otherwise. The path is the relay's own (config or Studio), never
 * taken from the request, so allowing it opens nothing.
 */
export function sendBrandLogo(res: Response, logo: BrandLogo | undefined): void {
  const missing = () => {
    if (res.headersSent) return;
    // A miss must not be cached: the logo may be fixed a moment later.
    res.setHeader("Cache-Control", "no-store");
    res.removeHeader("Content-Security-Policy");
    res
      .status(404)
      .type("application/json")
      .send(JSON.stringify({ ok: false }));
  };
  if (!logo) {
    missing();
    return;
  }
  res.setHeader("Content-Type", logo.contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(logo.path, { dotfiles: "allow" }, (error) => {
    if (error) missing();
  });
}
