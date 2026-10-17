import type { ReactNode } from "react";

interface Props {
  title: string;
  text?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}

/** Uniform empty state: icon, title, short text, call to action. */
export default function EmptyState({ title, text, icon, actions, compact }: Props) {
  return (
    <div className={`empty-state${compact ? " compact" : ""}`}>
      {icon && (
        <div className="empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="empty-title">{title}</div>
      {text && <div className="empty-text">{text}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}
