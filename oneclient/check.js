const fs = require("fs");
const toml = require("@iarna/toml");

const errors = [];

function checkMod(file) {
  const fileData = fs.readFileSync(file, "utf-8");
  const parsed = toml.parse(fileData);

  if (!parsed.id) {
    errors.push(`${file} doesn't have an id?`);
    return null;
  }

  if (!parsed.filename || !parsed.filename.endsWith(".jar")) {
    errors.push(`${file} invalid mod name`);
    return null;
  }

  if (!parsed.download?.url) {
    errors.push(`${file} doesn't have a download url?`);
    return null;
  }

  if (!parsed.update && !parsed.overrides) {
    errors.push(`${file} doesn't have overrides...`);
    return parsed.id;
  }

  if (parsed.update?.modrinth?.version) {
    const modVersion = parsed.update.modrinth.version;
    const split = parsed.download.url.split("/");
    if (split[split.length - 2] !== modVersion) {
      errors.push(`${file} has a bad download modrinth url. Please fix`);
      return parsed.id;
    }
  }

  return parsed.id;
}

function checkBundle(bundlePath, bundle) {
  const mods = fs.readdirSync(`${bundlePath}/mods`);
  const modIds = [];
  for (const mod of mods) {
    if (!mod.endsWith(".toml")) {
      errors.push(
        `${bundlePath} - Will not work because it contains a jar file`
      );
      return;
    }

    const path = `${bundlePath}/mods/${mod}`;
    const modId = checkMod(path);
    if (!modId) continue;
    if (modId.toLowerCase() === bundle.toLowerCase()) {
      errors.push(
        `${path} uses the defualt mod id. This is not recommended but not blocked`
      );
    }
    if (modIds.includes(modId)) {
      errors.push(`${path} has a duplicate mod id`);
    } else {
      modIds.push(modId);
    }
  }
}

const versions = fs.readdirSync("./oneclient/mrpacks/");
for (const version of versions) {
  const bundles = fs.readdirSync(`./oneclient/mrpacks/${version}`);
  for (const bundle of bundles) {
    checkBundle(`./oneclient/mrpacks/${version}/${bundle}`, bundle);
  }
}

if (errors.length > 0) {
  errors.forEach((error) => console.log(error));
  throw new Error("Something wen't wrong");
}
