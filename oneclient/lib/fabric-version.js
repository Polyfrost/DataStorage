"use strict";

/**
 * Fabric Loader version handling.
 *
 * This implements the subset of Fabric Loader's SemanticVersion + VersionPredicate
 * behaviour that we need to statically resolve `depends`/`breaks`/... ranges from
 * `fabric.mod.json`. It intentionally follows Fabric's grammar, NOT npm semver:
 *
 *   - A predicate value is a string OR an array of strings (array = logical OR).
 *   - A single predicate string is space-separated terms, all AND-ed together.
 *   - Each term has an optional operator prefix: >= <= > < = ~ ^  (default: =).
 *   - `*` / empty / the sentinel "IGNORED" (used by fabric_loader_dependencies.json)
 *     all mean "any version".
 *   - Version components may contain wildcards (x / X / *) which turn an operator-less
 *     term into a range (e.g. `1.2.x` => >=1.2.0 <1.3.0).
 *   - Build metadata (`+...`) is ignored in comparisons; pre-release (`-...`) sorts
 *     below the corresponding release.
 *
 * Reference: https://fabricmc.net/wiki/documentation:fabric_mod_json_spec
 */

const WILDCARD = Symbol("wildcard");

/**
 * Parse a version string into a structured semantic version, or return a
 * non-semantic marker (opaque string, equality-only) when it isn't parseable.
 *
 * @param {string} raw
 * @returns {{semantic: true, components: (number|symbol)[], prerelease: string|null, build: string|null, raw: string}
 *          | {semantic: false, raw: string}}
 */
function parseVersion(raw) {
  if (typeof raw !== "string") return { semantic: false, raw: String(raw) };
  const str = raw.trim();

  // Split off build metadata (ignored) then pre-release.
  let core = str;
  let build = null;
  const plus = core.indexOf("+");
  if (plus !== -1) {
    build = core.slice(plus + 1);
    core = core.slice(0, plus);
  }
  let prerelease = null;
  const dash = core.indexOf("-");
  if (dash !== -1) {
    prerelease = core.slice(dash + 1);
    core = core.slice(0, dash);
  }

  if (core.length === 0) return { semantic: false, raw: str };

  const parts = core.split(".");
  const components = [];
  for (const part of parts) {
    if (part === "x" || part === "X" || part === "*") {
      components.push(WILDCARD);
    } else if (/^\d+$/.test(part)) {
      components.push(parseInt(part, 10));
    } else {
      // Component is neither an integer nor a wildcard -> not a semantic version.
      return { semantic: false, raw: str };
    }
  }

  return { semantic: true, components, prerelease, build, raw: str };
}

function componentAt(version, i) {
  return i < version.components.length ? version.components[i] : 0;
}

/**
 * Compare two concrete semantic versions (no wildcards on either side expected).
 * A wildcard component is treated as 0 for ordering purposes.
 * @returns {number} -1 | 0 | 1
 */
function compareCore(a, b) {
  const len = Math.max(a.components.length, b.components.length);
  for (let i = 0; i < len; i++) {
    let ca = componentAt(a, i);
    let cb = componentAt(b, i);
    if (ca === WILDCARD) ca = 0;
    if (cb === WILDCARD) cb = 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return 0;
}

/** Compare pre-release strings per semver rules. Release (null) > any prerelease. */
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === null) return 1; // a is release, higher
  if (b === null) return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const x = pa[i];
    const y = pb[i];
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const dx = parseInt(x, 10);
      const dy = parseInt(y, 10);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (nx !== ny) {
      // numeric identifiers have lower precedence than non-numeric
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(a, b) {
  const c = compareCore(a, b);
  if (c !== 0) return c;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Index of the first wildcard component, or -1. */
function firstWildcard(version) {
  return version.components.findIndex((c) => c === WILDCARD);
}

/** Zero out wildcards (used as an inclusive lower bound). */
function stripWildcards(version) {
  return {
    semantic: true,
    components: version.components.map((c) => (c === WILDCARD ? 0 : c)),
    prerelease: version.prerelease,
    build: null,
    raw: version.raw,
  };
}

/**
 * Produce an exclusive upper bound by incrementing the component at `index`
 * (0-based) and zeroing everything after it. Missing components are treated as 0.
 */
function bumpAt(version, index) {
  const components = [];
  for (let i = 0; i <= index; i++) {
    let c = componentAt(version, i);
    if (c === WILDCARD) c = 0;
    components.push(i === index ? c + 1 : c);
  }
  return { semantic: true, components, prerelease: null, build: null, raw: "" };
}

/**
 * Turn a single term (already stripped of surrounding whitespace) into a
 * predicate function `(parsedVersion) => boolean`.
 */
function compileTerm(term) {
  term = term.trim();
  if (term === "" || term === "*" || term === "IGNORED") {
    return () => true;
  }

  let op = "=";
  const m = term.match(/^(>=|<=|>|<|=|~|\^)/);
  if (m) {
    op = m[1];
    term = term.slice(m[1].length).trim();
  }
  if (term === "" || term === "*") return () => true;

  const spec = parseVersion(term);

  // Non-semantic spec: only exact string equality is meaningful.
  if (!spec.semantic) {
    return (v) => (op === "=" || op === ">=" || op === "<=") && v.raw === spec.raw;
  }

  const wildIdx = firstWildcard(spec);

  // Operator-less (or "=") wildcard term behaves as a bounded range.
  if (wildIdx !== -1 && (op === "=" )) {
    if (wildIdx === 0) return () => true; // `x` / `*.*`
    const lower = stripWildcards(spec);
    const upper = bumpAt(spec, wildIdx - 1);
    return (v) => v.semantic && compareCore(v, lower) >= 0 && compareCore(v, upper) < 0;
  }

  const lowerBound = stripWildcards(spec);

  switch (op) {
    case ">":
      return (v) => v.semantic && compareVersions(v, lowerBound) > 0;
    case ">=":
      return (v) => v.semantic && compareVersions(v, lowerBound) >= 0;
    case "<":
      return (v) => v.semantic && compareVersions(v, lowerBound) < 0;
    case "<=":
      return (v) => v.semantic && compareVersions(v, lowerBound) <= 0;
    case "~": {
      // Same minor: >= spec, < bump(minor). If only major given, bump major.
      const bumpIndex = spec.components.length >= 2 ? 1 : 0;
      const upper = bumpAt(spec, bumpIndex);
      return (v) =>
        v.semantic && compareVersions(v, lowerBound) >= 0 && compareCore(v, upper) < 0;
    }
    case "^": {
      // Same major: >= spec, < bump(major).
      const upper = bumpAt(spec, 0);
      return (v) =>
        v.semantic && compareVersions(v, lowerBound) >= 0 && compareCore(v, upper) < 0;
    }
    case "=":
    default:
      return (v) => v.semantic && compareVersions(v, lowerBound) === 0;
  }
}

/** Compile a single predicate string: space-separated terms, all AND-ed. */
function compilePredicateString(str) {
  const terms = str.trim().split(/\s+/).filter(Boolean).map(compileTerm);
  if (terms.length === 0) return () => true;
  return (v) => terms.every((t) => t(v));
}

/**
 * Does `version` satisfy `predicate`?
 * @param {string} version       concrete version string (e.g. a mod's `version`)
 * @param {string|string[]} predicate  a fabric.mod.json range value (string or OR-array)
 * @returns {boolean}
 */
function matches(version, predicate) {
  const parsed = parseVersion(version);
  const list = Array.isArray(predicate) ? predicate : [predicate];
  // Empty array = no constraint.
  if (list.length === 0) return true;
  return list.some((p) => compilePredicateString(String(p))(parsed));
}

module.exports = { matches, parseVersion, compareVersions, WILDCARD };
