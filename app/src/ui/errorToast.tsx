// Toast body for a failed action: the user text (next step) from errors.ts → userMessage, the raw
// backend/DOM text only behind "Details" – like <ErrorNotice>, never `String(e)` as the body.

import type { ReactNode } from "react";
import { t } from "../i18n";
import { userMessage, type ErrorContext } from "../errors";

/** `title` (what failed, the caller's text) + body and screen-reader text for showToast. */
export function errorToast(title: string, e: unknown, ctx?: ErrorContext): { title: string; body: ReactNode; announce: string } {
  const m = userMessage(e, ctx);
  const announce = `${title}. ${m.hint}`;
  if (!m.detail) return { title, body: m.hint, announce };
  return {
    title,
    body: (
      <>
        {m.hint}
        <details className="alert-details">
          <summary>{t("shell.action.details")}</summary>
          <code>{m.detail}</code>
        </details>
      </>
    ),
    announce,
  };
}
