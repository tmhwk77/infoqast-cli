import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedTag = `v${packageJson.version}`;
const releaseTag = process.env.RELEASE_TAG;

if (releaseTag !== expectedTag) {
  throw new Error(`Release tag must be exactly ${expectedTag}`);
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const tagCommit = execFileSync("git", ["rev-list", "-n", "1", releaseTag], {
  encoding: "utf8",
}).trim();
if (head !== tagCommit) throw new Error("Checked-out commit does not match the release tag");

execFileSync("git", ["fetch", "origin", "main"], { stdio: "inherit" });
execFileSync("git", ["merge-base", "--is-ancestor", head, "origin/main"], {
  stdio: "ignore",
});
process.stdout.write(`release-ref: ${releaseTag} resolves to ${head} on main\n`);
