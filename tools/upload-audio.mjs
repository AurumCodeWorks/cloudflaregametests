// Uploads /audio/*.mp3 to the R2 bucket under audio/<version>/, where the Worker serves them.
// Run: node tools/upload-audio.mjs --local   (for `wrangler dev`)
//      node tools/upload-audio.mjs --remote  (for the deployed site)
// Bump VERSION (here and in public/sound.js) whenever a file changes: the URLs are cached for good.
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const VERSION = "v2";
const BUCKET = "cfgt-poker-hands";
const where = process.argv.includes("--remote") ? "--remote" : "--local";
const files = readdirSync("audio").filter((f) => f.endsWith(".mp3"));
for (const f of files) {
  execFileSync("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/audio/${VERSION}/${f}`, "--file", `audio/${f}`, "--content-type", "audio/mpeg", where], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`uploaded ${f}`);
}
console.log(`${files.length} files -> ${BUCKET}/audio/${VERSION}/ (${where.slice(2)})`);
