// English resources, one JSON file per area, mirrored on ../de/index.ts.
import approach from "./approach.json";
import common from "./common.json";
import countries from "./countries.json";
import landing from "./landing.json";
import live from "./live.json";
import logbook from "./logbook.json";
import map from "./map.json";
import review from "./review.json";
import settings from "./settings.json";
import shell from "./shell.json";

const en = { ...approach, ...common, ...countries, ...landing, ...live, ...logbook, ...map,...review, ...settings, ...shell };
export default en;
