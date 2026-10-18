// Web fonts for the landing card image. An SVG drawn as <img> cannot reach the page's
// @font-face rules, so the active theme's sans + num faces are inlined: the bundled
// Fontsource WOFF2 files (latin subset, upright, every weight the theme loads) are fetched
// once from their asset URLs, turned into data: URLs and cached per file. Anything that
// fails (no CSSOM access, fetch error) leaves the face out – the card then renders with
// the system fallback stack of themes.ts ("Segoe UI Variable", system-ui / "Cascadia
// Mono", Consolas), which its layout tolerates.

/** First family name of a CSS font stack: `"Geist Variable", system-ui` → `Geist Variable`. */
export function primaryFamily(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

/** Fontsource's latin subset starts with this range; latin-ext, cyrillic … are skipped. */
const LATIN = /U\+0+-0*FF\b/i;

export interface FaceRule {
  family: string;
  weight: string;
  url: string;
}

/** Upright latin @font-face rules of the given families in the document's style sheets (WOFF2 only). */
export function findFaces(sheets: Iterable<CSSStyleSheet>, families: string[]): FaceRule[] {
  const want = new Set(families.map((f) => f.toLowerCase()));
  const out: FaceRule[] = [];
  const visit = (rules: CSSRuleList, base: string) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSFontFaceRule) {
        const s = r.style;
        const family = primaryFamily(s.getPropertyValue("font-family"));
        if (!want.has(family.toLowerCase())) continue;
        if ((s.getPropertyValue("font-style") || "normal").trim() !== "normal") continue;
        const range = s.getPropertyValue("unicode-range");
        if (range && !LATIN.test(range)) continue;
        const m = /url\(\s*["']?([^"')]+\.woff2[^"')]*)["']?\s*\)/i.exec(s.getPropertyValue("src"));
        // relative to the style sheet (Vite rewrites to absolute asset URLs, but be safe)
        if (m) out.push({ family, weight: (s.getPropertyValue("font-weight") || "400").trim(), url: resolve(m[1], base) });
      } else if ("cssRules" in r && (r as CSSGroupingRule).cssRules) {
        visit((r as CSSGroupingRule).cssRules, base);
      }
    }
  };
  for (const sheet of sheets) {
    try {
      visit(sheet.cssRules, sheet.href ?? (typeof document !== "undefined" ? document.baseURI : "http://localhost/"));
    } catch {
      /* cross-origin sheet: not ours */
    }
  }
  return out;
}

function resolve(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

const cache = new Map<string, Promise<string | null>>();

function dataUrlOf(url: string): Promise<string | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(
        (b) =>
          new Promise<string>((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).replace(/^data:[^;,]*/, "data:font/woff2"));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(b);
          }),
      )
      .catch((e) => {
        console.warn("[landing card] font not embedded, system font is used", url, e);
        cache.delete(url);
        return null;
      });
    cache.set(url, p);
  }
  return p;
}

/** @font-face CSS with embedded WOFF2 for the families of `fontSans` / `fontNum`; "" when none could be loaded. */
export async function cardFontCss(fontSans: string, fontNum: string): Promise<string> {
  if (typeof document === "undefined" || typeof fetch === "undefined") return "";
  const faces = findFaces(Array.from(document.styleSheets), [primaryFamily(fontSans), primaryFamily(fontNum)]);
  const rules = await Promise.all(
    faces.map(async (f) => {
      const data = await dataUrlOf(f.url);
      return data ? `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};src:url(${data}) format("woff2");}` : "";
    }),
  );
  return rules.filter(Boolean).join("\n");
}
