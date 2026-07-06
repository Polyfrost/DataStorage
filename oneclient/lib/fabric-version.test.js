"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { matches, parseVersion, compareVersions } = require("./fabric-version.js");

test("exact match ignores build metadata", () => {
  assert.equal(matches("0.116.13+1.21.1", ">=0.116.0"), true);
  assert.equal(matches("0.116.13+1.21.1", "0.116.13"), true);
  assert.equal(matches("0.116.13+1.21.1", "0.116.13+9.9.9"), true); // build ignored
  assert.equal(matches("0.115.0", ">=0.116.0"), false);
});

test("comparison operators", () => {
  assert.equal(matches("1.21.1", ">=1.21.1"), true);
  assert.equal(matches("1.21.1", ">1.21.1"), false);
  assert.equal(matches("1.21.4", "<1.21.4"), false);
  assert.equal(matches("1.21.3", "<1.21.4"), true);
  assert.equal(matches("1.21.1", "<=1.21.1"), true);
});

test("space-separated terms are AND-ed (MC range)", () => {
  assert.equal(matches("1.21.1", ">=1.21.1 <1.21.4"), true);
  assert.equal(matches("1.21.4", ">=1.21.1 <1.21.4"), false);
  assert.equal(matches("1.20.6", ">=1.21.1 <1.21.4"), false);
});

test("array predicate is OR", () => {
  assert.equal(matches("1.21.1", ["1.20.1", ">=1.21"]), true);
  assert.equal(matches("1.19.2", ["1.20.1", ">=1.21"]), false);
});

test("wildcard / any / IGNORED", () => {
  assert.equal(matches("1.21.1", "*"), true);
  assert.equal(matches("literally-anything", "*"), true);
  assert.equal(matches("1.21.1", "IGNORED"), true);
  assert.equal(matches("1.21.1", ""), true);
  assert.equal(matches("1.21.1", []), true);
});

test("wildcard components become ranges", () => {
  assert.equal(matches("1.2.9", "1.2.x"), true);
  assert.equal(matches("1.3.0", "1.2.x"), false);
  assert.equal(matches("1.9.9", "1.x"), true);
  assert.equal(matches("2.0.0", "1.x"), false);
});

test("tilde = same minor", () => {
  assert.equal(matches("1.9.3", "~1.9"), true);
  assert.equal(matches("1.9.3", "~1.9.2"), true);
  assert.equal(matches("1.10.0", "~1.9"), false);
  assert.equal(matches("1.9.1", "~1.9.2"), false);
});

test("caret = same major", () => {
  assert.equal(matches("1.9.3", "^1.2.0"), true);
  assert.equal(matches("2.0.0", "^1.2.0"), false);
  assert.equal(matches("1.2.0", "^1.2.0"), true);
  assert.equal(matches("1.1.0", "^1.2.0"), false);
});

test("prerelease sorts below release", () => {
  const a = parseVersion("1.0.0-alpha");
  const b = parseVersion("1.0.0");
  assert.equal(compareVersions(a, b) < 0, true);
  assert.equal(matches("1.0.0-alpha", ">=1.0.0"), false);
  assert.equal(matches("1.0.0", ">=1.0.0"), true);
  assert.equal(matches("1.0.0-beta", ">1.0.0-alpha"), true);
});

test("shorter versions treat missing components as zero", () => {
  assert.equal(matches("1.21", ">=1.21.0"), true);
  assert.equal(matches("1.21", "1.21.0"), true);
  assert.equal(matches("1", ">=1.0.0"), true);
});

test("non-semantic versions fall back to equality", () => {
  assert.equal(matches("mc1.21", "mc1.21"), true);
  assert.equal(matches("mc1.21", ">=mc1.20"), false);
  assert.equal(matches("mc1.21", "*"), true);
});
