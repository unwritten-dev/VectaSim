// Photo credit links (Planespotters API, or an imported .vectasim bundle) are opened in the
// system browser: only Planespotters pages, never an arbitrary URL from the data.

const ALLOWED_ORIGIN = "https://www.planespotters.net";

/** The link when it is an https page on www.planespotters.net, else null (not opened, not shown as a link). */
export function planespottersLink(link: string | null | undefined): string | null {
  if (typeof link !== "string" || !link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  // origin compares scheme, host and port: no http, no look-alike host, no userinfo trick
  if (url.origin !== ALLOWED_ORIGIN || url.username || url.password) return null;
  return url.href;
}
