// "Verkehr" in the map toolbar plus the network choice next to it (VATSIM / IVAO / beide).
//
// The toggle switches the feeds themselves (online_set_networks), so map, side panel and
// settings can never disagree. The choice is the backend's while traffic is on; while it is
// off the last choice is remembered in localStorage, so "Verkehr" brings back the same networks.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Network, OnlineSummary } from "../types";
import { userMessage } from "../errors";
import { showToast } from "../ui/Toast";
import { useT, type TKey } from "../i18n";
import "./trafficToggle.css";

export type NetworkChoice = Network | "both";

const CHOICE_STORAGE_KEY = "vectasim.trafficNetwork";

export const CHOICES: Array<{ id: NetworkChoice; labelKey: TKey; titleKey: TKey }> = [
  { id: "vatsim", labelKey: "map.traffic.vatsim", titleKey: "map.traffic.vatsimTitle" },
  { id: "ivao", labelKey: "map.traffic.ivao", titleKey: "map.traffic.ivaoTitle" },
  { id: "both", labelKey: "map.traffic.both", titleKey: "map.traffic.bothTitle" },
];

export function networksOfChoice(choice: NetworkChoice): Network[] {
  return choice === "both" ? ["vatsim", "ivao"] : [choice];
}

/** Choice shown in the toolbar: what runs, else what ran last, else VATSIM (the former default). */
export function currentChoice(summary: Pick<OnlineSummary, "network"> | null, stored: string | null): NetworkChoice {
  const n = summary?.network;
  if (n === "vatsim" || n === "ivao" || n === "both") return n;
  return stored === "ivao" || stored === "both" ? stored : "vatsim";
}

function loadStored(): string | null {
  try {
    return localStorage.getItem(CHOICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(choice: NetworkChoice) {
  try {
    localStorage.setItem(CHOICE_STORAGE_KEY, choice);
  } catch {
    /* storage unavailable: the choice still applies for this session */
  }
}

interface Props {
  /** Some network is on (summary.enabled). */
  on: boolean;
  /** Called before traffic is switched on (LiveMap re-shows a hidden traffic layer). */
  onEnable?: () => void;
}

export default function TrafficToggle({ on, onEnable }: Props) {
  const t = useT();
  const [summary, setSummary] = useState<OnlineSummary | null>(null);
  const [stored, setStored] = useState<string | null>(loadStored);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const netRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let alive = true;
    invoke<OnlineSummary>("online_summary")
      .then((s) => alive && setSummary(s))
      // the toolbar falls back to the remembered choice
      .catch(() => {});
    const unlisten = listen<OnlineSummary>("online:summary", (e) => setSummary(e.payload));
    return () => {
      alive = false;
      void unlisten.then((f) => f());
    };
  }, []);

  const choice = currentChoice(on ? summary : null, stored);
  const choiceIndex = Math.max(0, CHOICES.findIndex((c) => c.id === choice));

  // close the menu on outside click and Escape. Escape is taken in the capture phase and
  // marked handled (preventDefault), so the traffic card's own Esc (window, bubble phase,
  // checks defaultPrevented) does not close the card at the same time.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      netRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // opening the menu puts the focus on the active network
  useEffect(() => {
    if (open) itemRefs.current[choiceIndex]?.focus();
    // only on opening; the index may change while the menu is closed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Up/Down (wrapping), Home/End move the focus in the menu; Tab closes it. */
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter((b): b is HTMLButtonElement => b != null);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };
  const label = t(CHOICES.find((c) => c.id === choice)?.labelKey ?? "map.traffic.vatsim");

  const apply = (networks: Network[], enable: boolean) => {
    setBusy(true);
    if (enable) onEnable?.();
    invoke<OnlineSummary>("online_set_networks", { networks })
      .then(setSummary)
      // the button stays as it was; say why instead of failing silently
      .catch((e) => {
        const m = userMessage(e, networks.length === 1 && networks[0] === "ivao" ? "ivao" : "vatsim");
        showToast({ id: "traffic-toggle", tone: "warn", title: enable ? t("map.traffic.enableFailed") : t("map.traffic.disableFailed"), body: `${m.title} ${m.hint}`, durationMs: 8000 });
      })
      .finally(() => setBusy(false));
  };

  const pick = (next: NetworkChoice) => {
    setOpen(false);
    netRef.current?.focus();
    store(next);
    setStored(next);
    // picking a network means "show me that traffic": it also switches traffic on
    apply(networksOfChoice(next), true);
  };

  const toggleTitle =
    choice === "both"
      ? on
        ? t("map.traffic.offTitleBoth")
        : t("map.traffic.onTitleBoth")
      : on
        ? t("map.traffic.offTitle", { network: label })
        : t("map.traffic.onTitle", { network: label });
  return (
    // split button: "Verkehr" (on/off) on the left, the network choice on the right, one frame
    //, so the choice no longer reads as a switched-off toggle of its own
    <span className={on ? "traffic-toggle traffic-split on" : "traffic-toggle traffic-split"} ref={wrapRef} role="group" aria-label={t("map.traffic.groupLabel")}>
      <button
        className="toggle traffic-main"
        onClick={() => apply(on ? [] : networksOfChoice(choice), !on)}
        disabled={busy}
        aria-pressed={on}
        title={toggleTitle}
      >
        {t("map.traffic.toggle")}
      </button>
      <button
        ref={netRef}
        className="traffic-net"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("map.traffic.network", { network: label })}
        title={t("map.traffic.networkTitle")}
      >
        {label}
        <span className="traffic-net-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="traffic-net-menu" role="menu" aria-label={t("map.traffic.networkMenu")} onKeyDown={onMenuKey}>
          {CHOICES.map((c, i) => (
            <button
              key={c.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              tabIndex={c.id === choice ? 0 : -1}
              role="menuitemradio"
              aria-checked={c.id === choice}
              className={c.id === choice ? "active" : undefined}
              onClick={() => pick(c.id)}
              title={t(c.titleKey)}
            >
              {t(c.labelKey)}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
