import { useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";

export interface SegmentOption<T> {
  value: T;
  label: ReactNode;
  title?: string;
  ariaLabel?: string;
}

interface Props<T> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Extra classes next to "segmented". */
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Render as <span> (inside a bar of inline controls). */
  inline?: boolean;
}

/** Index to select for `key` in a radio group (←/↑ previous, →/↓ next, wrapping; Home/End), else null. */
export function radioKeyIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  const i = current < 0 ? 0 : current;
  if (key === "ArrowRight" || key === "ArrowDown") return (i + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (i - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * Segmented control as a WAI-ARIA radio group: one tab stop (roving tabindex on the checked
 * option, else the first), arrow keys move and select – like ui/Tabs.
 */
export function Segmented<T>({ options, value, onChange, className, inline, ...aria }: Props<T>) {
  const ref = useRef<HTMLElement>(null);
  const checked = options.findIndex((o) => Object.is(o.value, value));
  const tabStop = checked < 0 ? 0 : checked;
  const onKey = (e: KeyboardEvent) => {
    const next = radioKeyIndex(e.key, checked, options.length);
    if (next == null) return;
    e.preventDefault();
    onChange(options[next].value);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  const buttons = options.map((o, i) => {
    const on = i === checked;
    return (
      <button
        key={String(o.value)}
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={o.ariaLabel}
        title={o.title}
        tabIndex={i === tabStop ? 0 : -1}
        className={on ? "active" : ""}
        onClick={() => onChange(o.value)}
      >
        {o.label}
      </button>
    );
  });
  const props = { className: `segmented${className ? ` ${className}` : ""}`, role: "radiogroup", onKeyDown: onKey, ...aria };
  return inline ? (
    <span ref={ref as Ref<HTMLSpanElement>} {...props}>
      {buttons}
    </span>
  ) : (
    <div ref={ref as Ref<HTMLDivElement>} {...props}>
      {buttons}
    </div>
  );
}
