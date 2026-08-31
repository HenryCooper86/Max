import { describe, expect, it } from "vitest";
import { staticCacheControl } from "../server/static-cache";

describe("static asset cache policy", () => {
  it("revalidates fixed-name fonts while retaining immutable hashed assets", () => {
    expect(staticCacheControl("/srv/dist/assets/app-8c4d1f.js")).toBe("public, max-age=31536000, immutable");
    expect(staticCacheControl("/srv/dist/fonts/space-mono-400.woff2")).toBe("public, max-age=0, must-revalidate");
    expect(staticCacheControl("/srv/dist/index.html")).toBe("no-cache, max-age=0, must-revalidate");
  });
});
