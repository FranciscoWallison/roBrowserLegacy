/**
 * tools/gen-field-adjacency.mjs
 *
 * Offline generator for the field-to-field adjacency table consumed by the
 * seamless-flight feature. Parses the rAthena field border-warp scripts and
 * emits src/DB/Map/FieldAdjacency.js.
 *
 * The rAthena warp grammar (TAB or space separated) is:
 *   <srcMap>,<x>,<y>,<dir>   warp   <warpName>   <xs>,<ys>,<dstMap>,<toX>,<toY>
 *
 * Only field<->field connections are emitted (e.g. prt_fild01 <-> prt_fild02).
 * Direction is derived size-independently from the coordinate flip between the
 * source edge and the destination edge (the warp pair always joins opposite
 * edges, so the seam axis is the one with the large coordinate delta).
 *
 * Run (offline only, never at runtime):
 *   node roBrowserLegacy/tools/gen-field-adjacency.mjs
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..'); // emulator/ragnarok

// Server warp script directories to scan (renewal + classic shared fields).
const WARP_DIRS = [
	join(REPO, 'rathena', 'npc', 're', 'warps', 'fields'),
	join(REPO, 'rathena', 'npc', 'warps', 'fields'),
];

const OUTPUT = resolve(__dirname, '..', 'src', 'Plugins', 'SeamlessFieldFlight', 'FieldAdjacency.js');
const MAP_INDEX = join(REPO, 'rathena', 'db', 'map_index.txt');

/** A map name is an open field iff it ends in `_fildNN` / `_fieldNN` or is `mjolnir_NN`. */
function isField(name) {
	return /(?:_fild|_field)\d+$/i.test(name) || /^mjolnir_\d+$/i.test(name);
}

/** Load the canonical list of valid map names (used only to drop typos). */
function loadValidMaps() {
	const set = new Set();
	if (!existsSync(MAP_INDEX)) {
		return null; // validation optional
	}
	for (const line of readFileSync(MAP_INDEX, 'utf8').split(/\r?\n/)) {
		const m = line.trim().match(/^([A-Za-z0-9_@#-]+)/);
		if (m && !line.trim().startsWith('//')) {
			set.add(m[1].toLowerCase());
		}
	}
	return set.size ? set : null;
}

function listWarpFiles() {
	const files = [];
	for (const dir of WARP_DIRS) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) {
			if (f.toLowerCase().endsWith('.txt')) files.push(join(dir, f));
		}
	}
	return files;
}

/**
 * Parse one warp line. Returns null for non-warp / comment / malformed lines.
 */
function parseWarp(line) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith('//')) return null;

	const parts = trimmed.split(/[\t ]+/);
	if (parts.length < 4) return null;
	if (!/^warp2?$/i.test(parts[1])) return null;

	const src = parts[0].split(',');
	const dst = parts[3].split(',');
	if (src.length < 3 || dst.length < 5) return null;

	const srcMap = src[0].toLowerCase();
	const sx = parseInt(src[1], 10);
	const sy = parseInt(src[2], 10);
	const xs = parseInt(dst[0], 10);
	const ys = parseInt(dst[1], 10);
	const dstMap = dst[2].toLowerCase();
	const tox = parseInt(dst[3], 10);
	const toy = parseInt(dst[4], 10);

	if ([sx, sy, tox, toy].some(Number.isNaN)) return null;

	return { srcMap, sx, sy, xs, ys, dstMap, tox, toy, warpName: parts[2] };
}

/** Size-independent direction + edge classification from the coordinate flip. */
function classify(w) {
	const dx = w.tox - w.sx;
	const dy = w.toy - w.sy;
	if (Math.abs(dx) >= Math.abs(dy)) {
		// East/West seam: x flips across the whole map, y stays ~constant.
		return {
			dir: w.sx > w.tox ? 'E' : 'W',
			edge: { axis: 'x', at: w.sx, cross: w.sy, span: w.ys },
			// Approx offset of dst-map origin in src-map cells (Phase-2 stitch).
			offset: { dx: w.sx - w.tox, dy: w.sy - w.toy },
		};
	}
	// North/South seam: y flips, x stays ~constant. RO y grows northward.
	return {
		dir: w.sy > w.toy ? 'N' : 'S',
		edge: { axis: 'y', at: w.sy, cross: w.sx, span: w.xs },
		offset: { dx: w.sx - w.tox, dy: w.sy - w.toy },
	};
}

function main() {
	const valid = loadValidMaps();
	const files = listWarpFiles();
	if (!files.length) {
		console.error('No warp files found under:', WARP_DIRS.join(', '));
		process.exit(1);
	}

	// table[srcMap][`${dstMap}|${dir}`] = neighbor record
	const table = {};
	let scanned = 0;
	let kept = 0;

	for (const file of files) {
		for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
			const w = parseWarp(line);
			if (!w) continue;
			scanned++;

			if (!isField(w.srcMap) || !isField(w.dstMap)) continue;
			if (w.srcMap === w.dstMap) continue;
			if (valid && (!valid.has(w.srcMap) || !valid.has(w.dstMap))) continue;

			const { dir, edge, offset } = classify(w);
			const key = `${w.dstMap}|${dir}`;
			const bucket = (table[w.srcMap] || (table[w.srcMap] = {}));

			if (!bucket[key]) {
				bucket[key] = {
					dir,
					map: w.dstMap,
					dst: { x: w.tox, y: w.toy },
					edge: { axis: edge.axis, at: edge.at, cross: [edge.cross, edge.cross] },
					offset,
					warps: 0,
				};
				kept++;
			}
			const rec = bucket[key];
			rec.warps++;
			// Widen the seam footprint to span all warp tiles on this edge.
			rec.edge.cross[0] = Math.min(rec.edge.cross[0], edge.cross);
			rec.edge.cross[1] = Math.max(rec.edge.cross[1], edge.cross);
		}
	}

	// Flatten into the output shape, keyed by bare lowercase source map name.
	const out = {};
	for (const srcMap of Object.keys(table).sort()) {
		out[srcMap] = { neighbors: Object.values(table[srcMap]) };
	}

	const banner =
		'/**\n' +
		' * Plugins/SeamlessFieldFlight/FieldAdjacency.js\n' +
		' *\n' +
		' * AUTO-GENERATED by tools/gen-field-adjacency.mjs — do not edit by hand.\n' +
		' * Field-to-field adjacency derived from rAthena border-warp scripts.\n' +
		' * Keyed by bare lowercase map name. `dst` is the server drop point;\n' +
		' * `offset` is an approximate dst-origin offset (cells) for stitched render.\n' +
		' */\n\n';

	const body = 'const FieldAdjacency = ' + JSON.stringify(out, null, '\t') + ';\n\nexport default FieldAdjacency;\n';

	writeFileSync(OUTPUT, banner + body, 'utf8');

	console.log(`Scanned ${scanned} warps across ${files.length} files.`);
	console.log(`Field maps with neighbors: ${Object.keys(out).length}, neighbor edges: ${kept}.`);
	console.log(`Wrote ${OUTPUT}`);
}

main();
