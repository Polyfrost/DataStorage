"use strict";

/**
 * Fabric mod compatibility checker for the OneClient bundles.
 *
 * For every bundle (oneclient/mrpacks/<mcver>-fabric/<Category>/) this:
 *   1. downloads each mod jar referenced by its .pw.toml and reads the real
 *      fabric.mod.json inside (plus nested jar-in-jar modules),
 *   2. applies the pack's config/fabric_loader_dependencies.json overrides,
 *   3. checks — the way Fabric Loader would — that:
 *        - every required `depends` (incl. `minecraft`, i.e. MC-version compat)
 *          resolves inside that single category,   -> FAIL
 *        - no `breaks` is triggered,                -> FAIL
 *        - `recommends`/`suggests` unmet            -> WARN
 *        - `conflicts` triggered                    -> WARN
 *   4. re-checks `breaks`/`conflicts` across the UNION of all categories of a
 *      given MC version (users combine categories in OneClient).
 *
 * A jar that can't be downloaded / unzipped / parsed, and the same mod pinned to
 * two different versions across categories, are also FAILs — a bundle entry that
 * won't load or is internally inconsistent is a broken bundle, not a footnote.
 *
 * Exit code 1 if any FAIL, else 0. WARN never changes the exit code.
 */

const fs = require("node:fs");
const path = require("node:path");
const toml = require("@iarna/toml");
const { matches } = require("./lib/fabric-version.js");
const { loadMod, cacheKeyFor } = require("./lib/modmeta.js");

const MRPACKS_DIR = path.join(__dirname, "mrpacks");
const CONCURRENCY = 8;

/** Java version bundled with the game for a given MC version. */
function javaForMc(mcVersion) {
  const major = parseInt(String(mcVersion).split(".")[0], 10);
  // MC 26.1+ ships Java 25; 1.21.x ships Java 21.
  return major >= 26 ? "25" : "21";
}

/** Built-in providers supplied by the game/loader for a given pack. */
function builtinProviders(mcVersion, fabricVersion) {
  return [
    { id: "minecraft", version: mcVersion },
    { id: "fabricloader", version: fabricVersion },
    { id: "fabric-loader", version: fabricVersion },
    { id: "java", version: javaForMc(mcVersion) },
  ];
}
// Loader-bundled ids we accept at any version (avoids false negatives on internals).
const ANY_VERSION_BUILTINS = new Set(["mixinextras"]);

const RELATIONS = ["depends", "recommends", "suggests", "breaks", "conflicts"];

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function readToml(file) {
  return toml.parse(fs.readFileSync(file, "utf-8"));
}

/** Gather every bundle and its parsed .pw.toml mod list. */
function discoverBundles() {
  const bundles = [];
  for (const versionDir of listDirs(MRPACKS_DIR)) {
    // e.g. "26.2-fabric" -> mcVersion "26.2", loader "fabric"
    const dash = versionDir.lastIndexOf("-");
    const mcVersion = versionDir.slice(0, dash);
    const loader = versionDir.slice(dash + 1);
    if (loader !== "fabric") continue;

    for (const category of listDirs(path.join(MRPACKS_DIR, versionDir))) {
      const bundleDir = path.join(MRPACKS_DIR, versionDir, category);
      const packFile = path.join(bundleDir, "pack.toml");
      if (!fs.existsSync(packFile)) continue;
      const pack = readToml(packFile);
      const fabricVersion = pack.versions?.fabric || "0.0.0";
      const mcFromPack = pack.versions?.minecraft || mcVersion;

      const modsDir = path.join(bundleDir, "mods");
      const mods = [];
      if (fs.existsSync(modsDir)) {
        for (const f of fs.readdirSync(modsDir)) {
          if (!f.endsWith(".pw.toml")) continue;
          mods.push({ file: path.join(modsDir, f), ...readToml(path.join(modsDir, f)) });
        }
      }

      bundles.push({
        versionDir,
        mcVersion: mcFromPack,
        fabricVersion,
        category,
        bundleDir,
        mods,
        overrides: loadOverrides(bundleDir),
      });
    }
  }
  return bundles;
}

/** Parse config/fabric_loader_dependencies.json if present. */
function loadOverrides(bundleDir) {
  const file = path.join(bundleDir, "config", "fabric_loader_dependencies.json");
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data.overrides || {};
  } catch {
    return {};
  }
}

/** Apply fabric_loader_dependencies.json overrides to a mod's normalized unit. */
function applyOverrides(unit, overrides) {
  const ov = overrides[unit.id];
  if (!ov) return unit;
  // Work on a shallow clone so the same jar reused elsewhere is unaffected.
  const out = { ...unit };
  for (const rel of RELATIONS) out[rel] = { ...(unit[rel] || {}) };

  for (const [key, value] of Object.entries(ov)) {
    if (RELATIONS.includes(key)) {
      out[key] = { ...value }; // full replace
    } else if (key.startsWith("+")) {
      const rel = key.slice(1);
      if (RELATIONS.includes(rel)) out[rel] = { ...out[rel], ...value };
    } else if (key.startsWith("-")) {
      const rel = key.slice(1);
      if (RELATIONS.includes(rel)) for (const k of Object.keys(value)) delete out[rel][k];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/** Build id -> [versions] map from a list of {id, version} providers. */
function providerMap(providers) {
  const map = new Map();
  for (const p of providers) {
    if (!p.id) continue;
    if (!map.has(p.id)) map.set(p.id, []);
    map.get(p.id).push(p.version);
  }
  return map;
}

/**
 * Resolve a single (id, range) requirement against a provider map.
 * @returns {"ok"|"missing"|"version"}
 */
function resolve(map, id, range) {
  if (ANY_VERSION_BUILTINS.has(id)) return "ok";
  const versions = map.get(id);
  if (!versions || versions.length === 0) return "missing";
  const r = range === undefined || range === null ? "*" : range;
  return versions.some((v) => matches(v, r)) ? "ok" : "version";
}

/** Is an incompatibility (breaks/conflicts) triggered by the current providers? */
function triggered(map, id, range) {
  const versions = map.get(id);
  if (!versions || versions.length === 0) return false;
  const r = range === undefined || range === null ? "*" : range;
  return versions.some((v) => matches(v, r));
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const bundles = discoverBundles();
  if (bundles.length === 0) {
    console.error("No fabric bundles found under oneclient/mrpacks/");
    process.exit(1);
  }

  // Collect every unique jar (by immutable cache key) and load it exactly once.
  const uniqueMods = new Map(); // cacheKey -> pwMod
  for (const b of bundles) for (const m of b.mods) uniqueMods.set(cacheKeyFor(m), m);

  console.log(
    `Loading ${uniqueMods.size} unique jars across ${bundles.length} bundles...`
  );
  const keys = [...uniqueMods.keys()];
  const loaded = new Map(); // cacheKey -> {primary, providers, warnings}
  let done = 0;
  await mapLimit(keys, CONCURRENCY, async (key) => {
    const res = await loadMod(uniqueMods.get(key));
    loaded.set(key, res);
    done++;
    if (done % 50 === 0 || done === keys.length) {
      process.stdout.write(`  ${done}/${keys.length}\r`);
    }
  });
  console.log("");

  const findings = []; // {level, version, category, msg}
  const globalWarnings = new Set();
  const add = (level, version, category, msg) =>
    findings.push({ level, version, category, msg });

  // Surface jar-level load warnings once each. A jar that can't be downloaded,
  // unzipped, or parsed is a broken bundle entry — treat it as a FAIL, not a note.
  // Only genuinely-benign cases ("no fabric.mod.json", i.e. a plain library jar)
  // stay as notes.
  const CRITICAL_LOAD = /(download failed|could not unzip|invalid fabric\.mod\.json|hash mismatch)/;
  for (const res of loaded.values()) {
    for (const w of res.warnings) {
      if (CRITICAL_LOAD.test(w)) add("FAIL", "jars", "load", w);
      else globalWarnings.add(w);
    }
  }

  // Group bundles by MC version for the cross-category pass.
  const byVersion = new Map();
  for (const b of bundles) {
    if (!byVersion.has(b.mcVersion)) byVersion.set(b.mcVersion, []);
    byVersion.get(b.mcVersion).push(b);
  }

  for (const [mcVersion, group] of byVersion) {
    const unionProviders = builtinProviders(mcVersion, group[0].fabricVersion);
    const unionMods = new Map(); // id -> {version, category}

    for (const b of group) {
      // Resolve each mod in this category, then build the category provider set.
      const primaries = [];
      const catProviders = builtinProviders(b.mcVersion, b.fabricVersion);

      for (const m of b.mods) {
        const res = loaded.get(cacheKeyFor(m));
        if (!res || !res.primary) continue;
        const unit = applyOverrides(res.primary, b.overrides);
        primaries.push(unit);
        catProviders.push(...res.providers);
        unionProviders.push(...res.providers);

        // Track for cross-category union / duplicate detection.
        const prev = unionMods.get(unit.id);
        if (prev && prev.version !== unit.version) {
          add(
            "FAIL",
            mcVersion,
            `${prev.category}✕${b.category}`,
            `"${unit.id}" pinned to ${prev.version} in ${prev.category} but ${unit.version} in ${b.category}`
          );
        }
        unionMods.set(unit.id, { version: unit.version, category: b.category });
      }

      const map = providerMap(catProviders);

      // Per-bundle: depends (FAIL), recommends/suggests (WARN), breaks (FAIL), conflicts (WARN).
      for (const unit of primaries) {
        for (const [id, range] of Object.entries(unit.depends || {})) {
          const r = resolve(map, id, range);
          if (r === "ok") continue;
          const why = r === "missing" ? "not provided" : `no version satisfies "${fmt(range)}"`;
          const label = id === "minecraft" ? "MC-incompatible" : "depends";
          add("FAIL", mcVersion, b.category, `${unit.id} ${label} ${id} — ${why}`);
        }
        for (const relName of ["recommends", "suggests"]) {
          for (const [id, range] of Object.entries(unit[relName] || {})) {
            if (resolve(map, id, range) !== "ok")
              add("WARN", mcVersion, b.category, `${unit.id} ${relName} ${id} — not satisfied`);
          }
        }
        for (const [id, range] of Object.entries(unit.breaks || {})) {
          if (triggered(map, id, range))
            add("FAIL", mcVersion, b.category, `${unit.id} breaks ${id} "${fmt(range)}" — present`);
        }
        for (const [id, range] of Object.entries(unit.conflicts || {})) {
          if (triggered(map, id, range))
            add("WARN", mcVersion, b.category, `${unit.id} conflicts ${id} "${fmt(range)}" — present`);
        }
      }
    }

    // Cross-category union: re-check breaks (FAIL) / conflicts (WARN) across everything.
    const unionMap = providerMap(unionProviders);
    for (const b of group) {
      for (const m of b.mods) {
        const res = loaded.get(cacheKeyFor(m));
        if (!res || !res.primary) continue;
        const unit = applyOverrides(res.primary, b.overrides);
        for (const [id, range] of Object.entries(unit.breaks || {})) {
          if (triggered(unionMap, id, range))
            add("FAIL", mcVersion, `${b.category}✕union`, `${unit.id} breaks ${id} "${fmt(range)}" — present in another category`);
        }
        for (const [id, range] of Object.entries(unit.conflicts || {})) {
          if (triggered(unionMap, id, range))
            add("WARN", mcVersion, `${b.category}✕union`, `${unit.id} conflicts ${id} "${fmt(range)}" — present in another category`);
        }
      }
    }
  }

  report(findings, globalWarnings);
  const fails = findings.filter((f) => f.level === "FAIL").length;
  process.exit(fails > 0 ? 1 : 0);
}

function fmt(range) {
  return Array.isArray(range) ? range.join(" || ") : String(range);
}

/** De-duplicate identical findings (union pass can repeat per-category ones). */
function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const k = `${f.level}|${f.version}|${f.category}|${f.msg}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function report(findingsRaw, globalWarnings) {
  const findings = dedupe(findingsRaw);
  const byVersion = new Map();
  for (const f of findings) {
    if (!byVersion.has(f.version)) byVersion.set(f.version, []);
    byVersion.get(f.version).push(f);
  }

  console.log("\n===== Fabric compatibility report =====");
  for (const [version, list] of [...byVersion.entries()].sort()) {
    console.log(`\n## ${version}`);
    for (const f of list.sort((a, b) => a.category.localeCompare(b.category))) {
      const tag = f.level === "FAIL" ? "❌ FAIL" : "⚠️  WARN";
      console.log(`  ${tag}  [${f.category}] ${f.msg}`);
    }
  }

  if (globalWarnings.size) {
    console.log("\n## notes");
    for (const w of [...globalWarnings].sort()) console.log(`  ℹ️  ${w}`);
  }

  const fails = findings.filter((f) => f.level === "FAIL").length;
  const warns = findings.filter((f) => f.level === "WARN").length;
  console.log(
    `\n===== ${fails} failure(s), ${warns} warning(s), ${globalWarnings.size} note(s) =====`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
