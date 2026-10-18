import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AirframeRow } from "../types";
import { airframeName, pickerOptions, shownAirframeName } from "./airframe";
import { usePrivacy } from "../prefs";
import AirframeImage from "./AirframeImage";

interface Props {
  /** Registration currently booked (highlighted, offered as "keep"). */
  current?: string | null;
  onPick: (registration: string | null) => void;
  onCancel: () => void;
}

/** Search existing airframes or type a new registration. Enter takes the first option. */
export default function AirframePicker({ current, onPick, onCancel }: Props) {
  const priv = usePrivacy();
  const [all, setAll] = useState<AirframeRow[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<AirframeRow[]>("list_airframes", { includeDemo: true })
      .then(setAll)
      .catch(() => setAll([]));
    inputRef.current?.focus();
  }, []);

  const { matches, newReg } = useMemo(() => pickerOptions(all, query), [all, query]);
  const options: Array<{ reg: string; row?: AirframeRow }> = [
    ...(newReg ? [{ reg: newReg }] : []),
    ...matches.map((row) => ({ reg: row.registration, row })),
  ];
  useEffect(() => setActive(0), [query]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && options[active]) {
      e.preventDefault();
      onPick(options[active].reg);
    }
  };

  return (
    <div className="af-picker" role="dialog" aria-label="Flugzeug ändern">
      <input
        ref={inputRef}
        type="search"
        placeholder="Registrierung, Name oder Typ – z. B. D-AINA"
        aria-label="Flugzeug suchen oder Registrierung eingeben"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        aria-controls="af-picker-list"
      />
      <ul id="af-picker-list" className="af-picker-list" role="listbox">
        {options.map((o, i) => (
          <li
            key={o.reg}
            role="option"
            aria-selected={i === active}
            className={`af-option${i === active ? " active" : ""}${o.reg === current ? " current" : ""}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(o.reg)}
          >
            {o.row ? (
              <>
                <AirframeImage airframe={o.row} className="af-mini" />
                <span className="af-option-text">
                  <strong className="num">{priv.mask(o.reg, "registration")}</strong>
                  <span className="detail">
                    {[airframeName(o.row) !== o.reg ? shownAirframeName(o.row, priv.on) : null, o.row.icaoType, `${o.row.totalFlights} Flüge`].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {o.reg === current && <span className="badge badge-inline">aktuell</span>}
              </>
            ) : (
              <span className="af-option-text">
                <strong className="num">+ {o.reg}</strong>
                <span className="detail">Neues Flugzeug mit dieser Registrierung anlegen</span>
              </span>
            )}
          </li>
        ))}
        {options.length === 0 && (
          <li className="af-option empty detail">{query.trim() ? "Keine Treffer – eine Registrierung hat 3–8 Zeichen (Buchstaben, Ziffern, Bindestrich)." : "Noch keine Flugzeuge – tippe eine Registrierung."}</li>
        )}
      </ul>
      <div className="af-picker-actions">
        {current && (
          <button className="btn-sm" onClick={() => onPick(null)} title="Flug keinem Flugzeug zuordnen">
            Zuordnung entfernen
          </button>
        )}
        <span className="spacer" />
        <button className="btn-sm" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
