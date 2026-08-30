import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");

test("Pages workflow has the required triggers and guarded update", () => {
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /cron: '17 3 \* \* 1,4'\n\s+timezone: Asia\/Tokyo/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.equal(workflow.match(/github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/g)?.length, 2);
});

test("deployment can only follow a successful validated build", () => {
  const update = workflow.indexOf("run: npm run update");
  const commit = workflow.indexOf("git add public/gyms.json data/geocode-cache.json");
  const build = workflow.indexOf("run: npm run build");
  const upload = workflow.indexOf("uses: actions/upload-pages-artifact@v4");
  assert.ok(update < commit && commit < build && build < upload);
  assert.match(workflow, /deploy:\n\s+needs: build/);
});
