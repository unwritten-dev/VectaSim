import { useId, type ReactNode } from "react";

/**
 * A text with the assessment profile's values as its tooltip, reachable without a mouse: the
 * element takes the keyboard focus and points with aria-describedby to the same lines in a
 * visually hidden element (a `title` alone is mouse-only, an aria-label on a plain span is
 * not read out).
 */
export default function ProfileTip({ tip, className, children, as: Tag = "span" }: { tip: string; className?: string; children: ReactNode; as?: "span" | "p" | "div" }) {
  const id = useId();
  return (
    <>
      <Tag className={className} title={tip} tabIndex={0} aria-describedby={id}>
        {children}
      </Tag>
      <span id={id} className="sr-only">
        {tip}
      </span>
    </>
  );
}
