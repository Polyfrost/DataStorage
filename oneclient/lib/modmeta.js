"use strict";

/**
 * Fetch a mod jar (via its packwiz `.pw.toml` download url), cache it, and extract
 * the `fabric.mod.json` metadata — including nested "jar-in-jar" (JiJ) mods, which is
 * how e.g. Fabric API provides all its `fabric-*` modules.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { unzipSync, strFromU8 } = require("fflate");

const CACHE_DIR = path.join(__dirname, "..", ".cache", "jars");

/** Derive a stable, immutable cache key from a packwiz mod entry. */
function cacheKeyFor(pwMod) {
  // Modrinth CDN urls look like .../data/<proj>/versions/<versionId>/<file>.jar
  const url = pwMod?.download?.url || "";
  const m = url.match(/\/versions\/([^/]+)\//);
  if (m) return m[1];
  // Fall back to the file hash (also immutable), else a hash of the url.
  if (pwMod?.download?.hash) return String(pwMod.download.hash).slice(0, 40);
  return crypto.createHash("sha1").update(url).digest("hex");
}

/**
 * Escape raw control characters (U+0000–U+001F) that appear *inside* string
 * literals. Fabric's Gson-based loader accepts unescaped newlines/tabs in e.g.
 * `description`, but strict JSON.parse rejects them ("Bad control character in
 * string literal"). We escape them so those (valid, working) mods still parse.
 */
function escapeControlCharsInStrings(s) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        out += c;
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = false;
        out += c;
        continue;
      }
      const code = s.charCodeAt(i);
      if (code < 0x20) {
        if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else if (c === "\t") out += "\\t";
        else out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  return out;
}

/** Strip // and /* *\/ comments and trailing commas, then JSON.parse. */
function parseLenientJson(text) {
  // Remove BOM.
  let s = text.replace(/^﻿/, "");
  // Escape raw control chars inside strings (structural whitespace untouched).
  s = escapeControlCharsInStrings(s);
  // Strip block comments.
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments (naive: not inside strings — acceptable for mod metadata).
  s = s.replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, "$1");
  // Remove trailing commas before } or ].
  s = s.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(s);
}

async function ensureCached(pwMod) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKeyFor(pwMod);
  const dest = path.join(CACHE_DIR, `${key}.jar`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return fs.readFileSync(dest);
  }

  const url = pwMod?.download?.url;
  if (!url) throw new Error(`no download url for ${pwMod?.filename || key}`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Verify integrity against the hash pinned in the .pw.toml (sha512/sha256/sha1).
  const fmt = (pwMod.download["hash-format"] || "sha512").replace(/-/g, "");
  const expected = pwMod.download.hash;
  if (expected) {
    const actual = crypto.createHash(fmt).update(buf).digest("hex");
    if (actual.toLowerCase() !== String(expected).toLowerCase()) {
      throw new Error(
        `hash mismatch for ${pwMod.filename}: expected ${fmt} ${expected}, got ${actual}`
      );
    }
  }

  fs.writeFileSync(dest, buf);
  return buf;
}

/** Normalize a raw fabric.mod.json object into the fields we resolve against. */
function normalizeUnit(fmj) {
  const rel = (v) => (v && typeof v === "object" ? v : {});
  const provides = Array.isArray(fmj.provides) ? fmj.provides : [];
  return {
    id: fmj.id,
    version: typeof fmj.version === "string" ? fmj.version : "0.0.0",
    provides,
    depends: rel(fmj.depends),
    recommends: rel(fmj.recommends),
    suggests: rel(fmj.suggests),
    breaks: rel(fmj.breaks),
    conflicts: rel(fmj.conflicts),
    environment: fmj.environment || "*",
    jars: Array.isArray(fmj.jars) ? fmj.jars : [],
  };
}

/**
 * Recursively read fabric.mod.json out of a jar buffer, collecting the top-level unit
 * and every nested JiJ unit. Returns { units, warnings }.
 */
function readUnitsFromJar(buf, label, warnings, depth = 0) {
  const units = [];
  let entries;
  try {
    entries = unzipSync(new Uint8Array(buf));
  } catch (e) {
    warnings.push(`${label}: could not unzip (${e.message})`);
    return units;
  }

  const fmjRaw = entries["fabric.mod.json"];
  if (!fmjRaw) {
    // Not a Fabric mod (e.g. a plain library jar or Quilt-only). Only warn at top level.
    if (depth === 0) warnings.push(`${label}: no fabric.mod.json (skipped)`);
    return units;
  }

  let unit;
  try {
    unit = normalizeUnit(parseLenientJson(strFromU8(fmjRaw)));
  } catch (e) {
    warnings.push(`${label}: invalid fabric.mod.json (${e.message})`);
    return units;
  }
  units.push(unit);

  // Recurse nested jars (jar-in-jar).
  for (const j of unit.jars) {
    const nestedRaw = j && j.file ? entries[j.file] : null;
    if (!nestedRaw) continue;
    const nested = readUnitsFromJar(
      Buffer.from(nestedRaw),
      `${label}!${j.file}`,
      warnings,
      depth + 1
    );
    for (const n of nested) units.push(n);
  }
  return units;
}

/**
 * Load a single packwiz mod: download+cache the jar, extract all Fabric units.
 * @returns {Promise<{primary: object|null, providers: {id:string,version:string}[], warnings: string[]}>}
 */
async function loadMod(pwMod) {
  const warnings = [];
  const label = pwMod.filename || pwMod.id || "<unknown>";
  let buf;
  try {
    buf = await ensureCached(pwMod);
  } catch (e) {
    return { primary: null, providers: [], warnings: [`${label}: ${e.message}`] };
  }

  const units = readUnitsFromJar(buf, label, warnings);
  if (units.length === 0) return { primary: null, providers: [], warnings };

  // The top-level unit is the actual installed mod; its relations are enforced.
  const primary = units[0];

  // Every unit (top-level + nested) contributes providers: its own id and each
  // `provides` alias (aliases inherit the declaring unit's version).
  const providers = [];
  for (const u of units) {
    if (u.id) providers.push({ id: u.id, version: u.version });
    for (const p of u.provides) {
      if (typeof p === "string") providers.push({ id: p, version: u.version });
      else if (p && p.id) providers.push({ id: p.id, version: p.version || u.version });
    }
  }

  return { primary, providers, warnings };
}

module.exports = { loadMod, cacheKeyFor, parseLenientJson, CACHE_DIR };
