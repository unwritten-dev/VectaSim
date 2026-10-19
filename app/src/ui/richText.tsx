// Inserts React nodes into a translated sentence: t() leaves placeholders it has no value
// for as `{name}`, so a whole sentence stays one key and only the highlighted parts
// (<code>, <b>, links) are elements. Unknown placeholders stay visible as text.
//
//   rich(t("settings.server.obsHelp"), { scale: <code>?scale=1.5</code> })

import { Fragment, type ReactNode } from "react";

export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    const node = m && m[1] in nodes ? nodes[m[1]] : part;
    return <Fragment key={i}>{node}</Fragment>;
  });
}
