import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Airframe } from "../types";
import { silhouettePath, wakeCategory } from "../map/aircraftIcons";
import { usePrefs } from "../prefs";
import { privacy } from "../format";
import { needsPhotoLookup, photoCredit } from "./airframe";

// One lazy lookup per registration and app session; the backend caches and rate-limits,
// this only keeps a list of thumbnails from asking again on every re-render.
const asked = new Set<string>();

/** Ask the backend for a photo when the cached state is stale (result arrives as `airframes:changed`). */
export function useLazyPhoto(a: Airframe | null | undefined) {
  const { airframePhotos } = usePrefs();
  const reg = a?.registration;
  const stale = !!a && needsPhotoLookup(a, Date.now());
  useEffect(() => {
    if (!reg || !stale || !airframePhotos || asked.has(reg)) return;
    asked.add(reg);
    // failures are logged by the backend and retried later; the placeholder stays
    invoke("airframe_photo", { registration: reg }).catch(() => {});
  }, [reg, stale, airframePhotos]);
}

function src(a: Airframe, size: "thumb" | "large"): string | null {
  const url = size === "thumb" ? (a.imageThumbUrl ?? a.imageUrl) : (a.imageUrl ?? a.imageThumbUrl);
  if (!url) return null;
  return a.imageSource === "user" ? convertFileSrc(url) : url;
}

/** Type silhouette (wake class) for airframes without a photo. */
export function AirframeSilhouette({ icaoType, title }: { icaoType?: string | null; title?: string | null }) {
  const cat = wakeCategory(icaoType, title);
  return (
    <svg className="af-silhouette" viewBox="0 0 48 48" aria-hidden="true">
      <path d={silhouettePath(cat)} transform="rotate(45 24 24)" />
    </svg>
  );
}

interface Props {
  airframe: Airframe | null | undefined;
  size?: "thumb" | "large";
  /** Show the credit line under a large photo. */
  credit?: boolean;
  className?: string;
  /** Silhouette facts when there is no airframe (yet). */
  fallbackType?: string | null;
  fallbackTitle?: string | null;
}

/** Photo of an airframe (Planespotters or picked), else its type silhouette. Triggers the lazy lookup. */
export default function AirframeImage({ airframe: a, size = "thumb", credit = false, className = "", fallbackType, fallbackTitle }: Props) {
  useLazyPhoto(a);
  // re-render with the Streamer-Modus (alt text)
  const { privacyMode } = usePrefs();
  const url = a ? src(a, size) : null;
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const line = a ? photoCredit(a) : null;
  const show = !!url && !broken;
  // Planespotters requires the photographer credit and a link on every displayed photo; where
  // the caption line is not shown (thumbnails, inside buttons) a small "©" overlay carries both.
  const overlay = show && a?.imageSource === "planespotters" && !!line && !(credit && size === "large");
  const openLink = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (a?.imageLink) openUrl(a.imageLink).catch(() => {});
  };
  return (
    <figure className={`af-image af-${size} ${className}`}>
      <div className="af-frame">
        {show ? (
          <img src={url} alt={a ? `Foto ${privacy(a.registration, "registration", privacyMode)}` : ""} loading="lazy" onError={() => setBroken(true)} draggable={false} />
        ) : (
          <AirframeSilhouette icaoType={a?.icaoType ?? fallbackType} title={a?.title ?? fallbackTitle} />
        )}
        {overlay && (
          <span
            className="af-credit-badge"
            role={a?.imageLink ? "link" : undefined}
            tabIndex={a?.imageLink ? 0 : undefined}
            title={a?.imageLink ? `${line} – Foto auf Planespotters.net öffnen` : line!}
            aria-label={line!}
            onClick={openLink}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") openLink(e);
            }}
          >
            ©
          </span>
        )}
      </div>
      {credit && size === "large" && (
        <figcaption className="af-credit detail">
          {show && line ? (
            a?.imageLink ? (
              <button className="link-btn" onClick={() => openUrl(a.imageLink!).catch(() => {})} title={a.imageLink}>
                {line}
              </button>
            ) : (
              line
            )
          ) : a?.imageSource === "none" ? (
            "Kein Foto zu dieser Registrierung gefunden"
          ) : (
            "Noch kein Foto"
          )}
        </figcaption>
      )}
    </figure>
  );
}
