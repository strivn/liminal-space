// Liminal space page: esbuild bundles this entry and site/page/ into one classic script, site/app.js. The page's data
// are static files beside it (scripts/deploy/build-site.ts): data/index.json, then one file per month, read with fetch at
// addresses relative to the page. The pure modules in site/page/ are what the unit tests import.
import { startReloadAtTop } from "./page/contents.ts";
import { start } from "./page/render.ts";

// Entry point: read the data and draw. A reload's jump to the top is set up now, before the data arrive, as it must
// be before DOMContentLoaded.
if (typeof document !== "undefined") {
	startReloadAtTop();
	start().catch((error) => {
		console.error("The page couldn't be drawn:", error);
	});
}
