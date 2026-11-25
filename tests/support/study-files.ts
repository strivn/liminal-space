// Print the files scripts/deploy/build-site.ts builds for the studies on stdin (one Study per line) as JSON: each file's
// path under the page's folder and its text. The jsdom tests run this as a program, since jsdom's URL is not Node's.
import { readFileSync } from "node:fs";
import { studyFiles } from "../../scripts/deploy/build-site.ts";

const files = studyFiles(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(Object.fromEntries(files)));
