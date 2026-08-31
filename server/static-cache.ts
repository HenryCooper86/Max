export function staticCacheControl(filePath: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (normalizedPath.includes("/assets/")) return "public, max-age=31536000, immutable";
  if (normalizedPath.includes("/fonts/")) return "public, max-age=0, must-revalidate";
  return "no-cache, max-age=0, must-revalidate";
}
