// German resources (the reference for all keys). One JSON file per area, so parallel work on
// different areas never edits the same file; add a new area as one import + one spread line
// here and in ../en/index.ts (keep the order alphabetical).
import approach from "./approach.json";
import common from "./common.json";
import countries from "./countries.json";
import gload from "./gload.json";
import landing from "./landing.json";
import live from "./live.json";
import logbook from "./logbook.json";
import map from "./map.json";
import review from "./review.json";
import settings from "./settings.json";
import shell from "./shell.json";

const de = { ...approach, ...common, ...countries, ...gload, ...landing, ...live, ...logbook, ...map,...review, ...settings, ...shell };
export default de;
