import { useRef, useState, type ReactNode } from "react";
import { SOURCE_LABEL, SOURCE_NAME, type SourceKind } from "../landing/facts";
import Popover from "./Popover";
import { useT } from "../i18n";

interface Props {
  kind: SourceKind;
  /** What exactly the value is and where it comes from. */
  detail: ReactNode;
  /** Sources disagree (e.g. sim vs. measured landing rate > 50 fpm): amber chip. */
  warn?: boolean;
}

/**
 * Provenance chip next to a value (every number shows where it comes from): SIM / GEM. /
 * ABGEL. in small mono caps; a click opens the explanation.
 */
export default function SourceChip({ kind, detail, warn }: Props) {
  const t = useT();
  const name = warn ? t("shell.source.nameDiffers", { name: SOURCE_NAME[kind] }) : SOURCE_NAME[kind];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`source-chip source-${kind}${warn ? " warn" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("shell.source.aria", { name })}
        title={name}
      >
        {SOURCE_LABEL[kind]}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} label={t("shell.source.popover")} placement="bottom-end" className="source-popover">
        <strong className="source-pop-title">
          {SOURCE_NAME[kind]}
          {warn && <span className="warn-text"> · {t("shell.source.differs")}</span>}
        </strong>
        <div className="detail">{detail}</div>
      </Popover>
    </>
  );
}
