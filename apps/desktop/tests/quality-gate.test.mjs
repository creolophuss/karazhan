import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("one root quality gate covers Rust, SQLite-backed tests, and the frontend build", async () => {
  const script = await readFile(
    path.join(repositoryRoot, "scripts/check.sh"),
    "utf8",
  );
  const required = [
    "cargo fmt --check",
    "cargo clippy --offline --workspace --all-targets -- -D warnings",
    "cargo test --offline --workspace",
    "npm run frontend:check",
  ];
  let previous = -1;
  for (const command of required) {
    const current = script.indexOf(command);
    assert.ok(current > previous, `missing or out-of-order quality step: ${command}`);
    previous = current;
  }

  const rootPackage = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(rootPackage.scripts.check, "./scripts/check.sh");
  assert.equal(
    rootPackage.scripts["frontend:check"],
    "npm --workspace @karazhan/desktop run check",
  );
});
