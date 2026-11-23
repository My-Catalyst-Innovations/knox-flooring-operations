export function microsoftFileUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (host.endsWith(".sharepoint.com") || host.endsWith(".sharepoint.us") || host.endsWith(".sharepoint.de") || host === "onedrive.live.com" || host === "1drv.ms") return url.href;
  } catch { /* Hide an invalid provider link. */ }
  return undefined;
}
