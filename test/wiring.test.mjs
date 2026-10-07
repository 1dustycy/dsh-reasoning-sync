/**
 * The wiring contract: this package must be mountable by DSH the way every
 * other bundle is, and it must be mountable *from the profile that actually
 * loads it*.
 *
 * DSH composes a profile by resolving each `dsh.profile.bundles` entry to its
 * package, reading that package's `dsh.bundle.patch`, and applying the patch
 * entries; the browser half is then discovered through the package's
 * `dsh.client` declaration. None of that is a place a typo announces itself as
 * a typo, so the suite resolves the same chain against the live profile when it
 * is present.
 *
 * The profile check skips (loudly) when no profile links this package, so the
 * repo stays runnable anywhere while a machine that installed it gets the real
 * check. The patch parsing is deliberately a few lines rather than a YAML
 * dependency: the file this repo ships is simple enough that a parser would be
 * more machinery than the thing it checks.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's root. */
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
/** The manifest of this package. */
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
/** The profile that links this package, if the caller points the suite at one. */
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(process.env.HOME ?? "", ".dsh", "profiles", "desktop");

/**
 * Parse the two-level `- insert:` / `- id:` / `name:` shape this repo's patch
 * uses. A patch file that grows beyond that shape fails loudly here rather than
 * being quietly mis-read.
 * @param source - the patch file's text.
 * @returns the inserted rows, in order.
 */
function parseInsertPatch(source) {
	const rows = [];
	let current;
	for (const line of source.split("\n")) {
		const text = line.trim();
		if (text === "" || text.startsWith("#")) continue;
		if (text === "- insert:") {
			current = {};
			rows.push(current);
			continue;
		}
		const match = /^-?\s*(id|name|disabled):\s*(.+)$/u.exec(text);
		if (match === null) throw new Error(`unparsed patch line: ${JSON.stringify(line)}`);
		assert.notEqual(current, void 0, `a patch field appeared before an insert list: ${JSON.stringify(line)}`);
		current[match[1]] = match[2];
	}
	return rows;
}

// --- the package's own declarations -----------------------------------------

assert.equal(manifest.name, "dsh-reasoning-sync", "the package name is the bundle name profiles list");
assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml", "the bundle declares its patch file");
assert.equal(manifest.dsh?.client?.platform, "web", "the browser half serves the web platform");
assert.equal(manifest.exports?.["./client"]?.default, "./lib/client.js", "the browser half is reachable at ./client");
assert.ok(existsSync(join(PACKAGE_DIR, "lib", "index.js")), "the host half exists");
assert.ok(existsSync(join(PACKAGE_DIR, manifest.exports["./client"].default)), "the browser half exists");

// --- the bundle patch mounts exactly one row ---------------------------------

const patchPath = resolve(PACKAGE_DIR, manifest.dsh.bundle.patch);
const rows = parseInsertPatch(readFileSync(patchPath, "utf8"));
assert.equal(rows.length, 1, "the bundle patch inserts one row");
const [row] = rows;
assert.equal(row.name, manifest.name, "the mounted row names this package");
assert.equal(row.id, "reasoning-sync", "the row id is the one the profile layer would address");
assert.equal(row.disabled, void 0, "the row mounts enabled");

// --- the row resolves from the profile that loads it -------------------------

if (!existsSync(join(PROFILE_DIR, "package.json"))) {
	console.log(`reasoning-sync: SKIPPED the live-profile wiring check — ${PROFILE_DIR} has no package.json`);
} else {
	// The profile manifest must list the bundle; otherwise the patch never applies.
	const profile = JSON.parse(readFileSync(join(PROFILE_DIR, "package.json"), "utf8"));
	if (!profile.dsh?.profile?.bundles?.includes(manifest.name)) {
		console.log(`reasoning-sync: SKIPPED the live-profile wiring check — ${PROFILE_DIR} does not list ${manifest.name} in dsh.profile.bundles`);
	} else {
		// DSH resolves a bundle name against the profile's own node_modules after
		// the installation; the link pnpm installs is what makes this work.
		const linked = join(PROFILE_DIR, "node_modules", manifest.name, "package.json");
		assert.ok(existsSync(linked), `${PROFILE_DIR}/node_modules links ${manifest.name} — run the install`);
		const linkedManifest = JSON.parse(readFileSync(linked, "utf8"));
		assert.equal(linkedManifest.dsh?.bundle?.patch, manifest.dsh.bundle.patch, "the linked copy is this package, not a stale one");

		// The bundle layer of the mounted row must be readable from the profile too,
		// because that is the anchor DSH applies it with.
		assert.ok(existsSync(join(dirname(linked), manifest.dsh.bundle.patch)), "the linked package carries its patch file");

		console.log(`reasoning-sync: bundle resolves from ${PROFILE_DIR} and its patch mounts row ${row.id}`);
	}
}
