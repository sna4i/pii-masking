#!/usr/bin/env node
// scripts/validate_vectors.js
//
// Runs every JSON file under ``tests/vectors/`` through the pure-JS
// engine and asserts each ``expected`` / ``expected_absent`` /
// ``expected_aggregated`` / ``expected_forced_categories`` clause.
//
// Usage:
//   node scripts/validate_vectors.js
//
// Exit code:
//   0 on all vectors pass
//   1 on any failure
//
// Output (stdout):
//   One ``  [PASS] <file>::<case>`` or ``  [FAIL] ...`` line per case,
//   then a summary ``✓ N pass, ✗ M fail``.

"use strict";

const fs = require("fs");
const path = require("path");

const ENGINE_DIR = path.join(__dirname, "..", "browser-extension", "engine");
const VECTORS_DIR = path.join(__dirname, "..", "tests", "vectors");

// Load the engine. Each module attaches to module.exports under Node.
// engine.js itself is a facade that pulls in every submodule.
const engine = require(path.join(ENGINE_DIR, "engine.js"));
require(path.join(ENGINE_DIR, "patterns.js"));
require(path.join(ENGINE_DIR, "classification.js"));
require(path.join(ENGINE_DIR, "severity.js"));
require(path.join(ENGINE_DIR, "categories.js"));
require(path.join(ENGINE_DIR, "aggregate.js"));
require(path.join(ENGINE_DIR, "force-mask.js"));
require(path.join(ENGINE_DIR, "blocklist.js"));

async function runCase(vector, caseDef) {
  const mode = vector.mode || "detection";
  const input = caseDef.input;
  if (typeof input !== "string") {
    return {
      ok: false,
      reason: `case.input missing or not a string`,
    };
  }

  // A case may narrow the engine the way a caller would, e.g. to prove a
  // label survives its neighbours' category being switched off.
  const opts = {};
  if (Array.isArray(caseDef.disabled_categories)) {
    opts.disabledCategories = caseDef.disabled_categories;
  }
  const result = await engine.maskAggregated(input, opts);
  const aggregated = result.aggregated || [];
  const errors = [];

  if (mode === "force_mask") {
    const expected = caseDef.expected_forced_categories || [];
    const actual = result.force_masked_categories || [];
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    if (expectedSet.size !== actualSet.size) {
      errors.push(
        `force_masked_categories mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    } else {
      for (const cat of expectedSet) {
        if (!actualSet.has(cat)) {
          errors.push(`missing forced category: ${cat}`);
        }
      }
    }
  } else if (mode === "aggregation") {
    for (const exp of caseDef.expected_aggregated || []) {
      const found = aggregated.find(
        (a) => a.value === exp.value && a.label === exp.label
      );
      if (!found) {
        errors.push(
          `expected aggregated value=${JSON.stringify(exp.value)} label=${exp.label} not found`
        );
        continue;
      }
      if (
        typeof exp.placeholder === "string" &&
        found.placeholder !== exp.placeholder
      ) {
        errors.push(
          `placeholder mismatch for ${exp.value}: expected ${exp.placeholder}, got ${found.placeholder}`
        );
      }
      if (typeof exp.count === "number" && found.count !== exp.count) {
        errors.push(
          `count mismatch for ${exp.value}: expected ${exp.count}, got ${found.count}`
        );
      }
    }
  } else {
    // Default "detection" mode — check expected / expected_absent.
    for (const exp of caseDef.expected || []) {
      const found = aggregated.find(
        (a) =>
          a.label === exp.label &&
          (typeof exp.text !== "string" || a.value === exp.text)
      );
      if (!found) {
        errors.push(
          `expected label=${exp.label}${exp.text ? ` text=${JSON.stringify(exp.text)}` : ""} not found; aggregated=${JSON.stringify(
            aggregated.map((a) => ({ label: a.label, value: a.value }))
          )}`
        );
      }
    }
    for (const exp of caseDef.expected_absent || []) {
      const found = aggregated.find(
        (a) =>
          a.label === exp.label &&
          (typeof exp.text !== "string" || a.value === exp.text)
      );
      if (found) {
        errors.push(
          `unexpected label=${exp.label} text=${JSON.stringify(found.value)}`
        );
      }
    }
  }

  if (errors.length === 0) return { ok: true };
  return { ok: false, reason: errors.join("; ") };
}

async function main() {
  if (!fs.existsSync(VECTORS_DIR)) {
    console.error(`vectors directory not found: ${VECTORS_DIR}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let total = 0;
  let pass = 0;
  const failures = [];
  const perCategory = {};

  for (const fname of files) {
    const fullPath = path.join(VECTORS_DIR, fname);
    let vector;
    try {
      vector = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch (e) {
      console.error(`  [FAIL] ${fname} :: parse error: ${e.message}`);
      failures.push({ file: fname, case: "<parse>", reason: e.message });
      continue;
    }
    const cases = vector.cases || [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const name = c.name || `case#${i + 1}`;
      total += 1;
      const res = await runCase(vector, c);
      perCategory[fname] = perCategory[fname] || { pass: 0, fail: 0 };
      if (res.ok) {
        pass += 1;
        perCategory[fname].pass += 1;
        console.log(`  [PASS] ${fname} :: ${name}`);
      } else {
        perCategory[fname].fail += 1;
        failures.push({ file: fname, case: name, reason: res.reason });
        console.log(`  [FAIL] ${fname} :: ${name}`);
        console.log(`         ${res.reason}`);
      }
    }
  }

  console.log("");
  console.log(
    `Result: ${pass} / ${total} passed (${failures.length} failed)`
  );
  console.log("Per-category:");
  for (const [file, stats] of Object.entries(perCategory)) {
    const status = stats.fail === 0 ? "OK" : "FAIL";
    console.log(
      `  ${status.padEnd(5)} ${file}  ${stats.pass} pass / ${stats.fail} fail`
    );
  }

  if (failures.length > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(`validator crashed: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
