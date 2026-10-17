import React from "react";
import ReactDOM from "react-dom/client";
// Bundled fonts (OFL) of the default theme Signal: Geist for the UI, Geist Mono for readouts
// (the other themes load theirs on demand, themes.ts FONT_LOADERS).
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import App from "./App";
import { initTheme } from "./prefs";

// theme tokens before the first paint (cached choice, else Signal; the stored one arrives with loadPrefs)
initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
