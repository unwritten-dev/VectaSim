import { userMessage, type ErrorContext } from "./errors";
import { useT } from "./i18n";

interface Props {
  error: unknown;
  context?: ErrorContext;
  /** SimBrief user, for "Kein OFP für „…“ gefunden". */
  user?: string;
  tone?: "err" | "warn";
  onRetry?: () => void;
  onDismiss?: () => void;
  compact?: boolean;
}

/** Inline error at the place of the problem: user text + next step, raw text behind "Details". */
export default function ErrorNotice({ error, context, user, tone = "err", onRetry, onDismiss, compact }: Props) {
  const t = useT();
  const msg = userMessage(error, context, { user });
  return (
    <div className={`alert${tone === "warn" ? " warn-alert" : ""}${compact ? " compact" : ""}`} role="alert">
      <div className="alert-main">
        <span className="alert-icon" aria-hidden="true">
          {tone === "warn" ? "▲" : "!"}
        </span>
        <div className="alert-text">
          <strong>{msg.title}</strong> <span>{msg.hint}</span>
        </div>
        {onRetry && (
          <button className="btn btn-sm" onClick={onRetry}>
            {t("shell.action.retry")}
          </button>
        )}
        {onDismiss && (
          <button className="btn btn-sm btn-ghost" onClick={onDismiss} aria-label={t("shell.errorNotice.dismiss")}>
            {t("shell.action.close")}
          </button>
        )}
      </div>
      {msg.detail && msg.detail !== msg.title && (
        <details className="alert-details">
          <summary>{t("shell.action.details")}</summary>
          <code>{msg.detail}</code>
        </details>
      )}
    </div>
  );
}
