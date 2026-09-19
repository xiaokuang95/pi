/**
 * Compile TypeScript extensions to sidecar `.pi.mjs` so startup can native-import
 * them. Host pi packages are rewritten to the running process's files, not nested
 * copies under the extension.
 */

import * as fs from "node:fs";
import * as nodeModule from "node:module";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const TS_FILE = /\.([cm]?ts|tsx)$/;
const JS_FILE = /\.([cm]?js|jsx)$/;
const SPECIFIER_RE = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const COMPILED_SUFFIX = ".pi.mjs";

let hostAliases: Record<string, string> | undefined;

export function isTypeScriptExtensionPath(filePath: string): boolean {
	if (filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts")) {
		return false;
	}
	return TS_FILE.test(filePath);
}

export function compiledExtensionPath(sourcePath: string): string {
	const parsed = path.parse(sourcePath);
	return path.join(parsed.dir, `${parsed.name}${COMPILED_SUFFIX}`);
}

export async function compileTypeScriptExtensionEntries(entryPaths: string[]): Promise<void> {
	for (const entryPath of entryPaths) {
		if (isTypeScriptExtensionPath(entryPath) && fs.existsSync(entryPath)) {
			await compileExtensionToJs(entryPath);
		}
	}
}

export async function compileExtensionToJs(sourcePath: string): Promise<string> {
	const resolved = path.resolve(sourcePath);
	const outPath = compiledExtensionPath(resolved);
	if (isCompiledFresh(resolved, outPath)) {
		return outPath;
	}
	if (await compileWithBun(resolved, outPath)) {
		return outPath;
	}
	compileWithStrip(resolved, outPath, new Set());
	return outPath;
}

function isCompiledFresh(sourcePath: string, outPath: string): boolean {
	// ponytail: entry mtime only; hash the import graph if sibling edits don't rebuild
	if (!fs.existsSync(outPath)) {
		return false;
	}
	return fs.statSync(outPath).mtimeMs >= fs.statSync(sourcePath).mtimeMs;
}

async function compileWithBun(sourcePath: string, outPath: string): Promise<boolean> {
	const bun = (
		globalThis as {
			Bun?: {
				build?: (opts: {
					entrypoints: string[];
					outdir: string;
					naming: string;
					target: string;
					format: string;
					packages: string;
				}) => Promise<{ success: boolean }>;
			};
		}
	).Bun;
	if (typeof bun?.build !== "function") {
		return false;
	}
	const result = await bun.build({
		entrypoints: [sourcePath],
		outdir: path.dirname(outPath),
		naming: path.basename(outPath),
		target: "bun",
		format: "esm",
		packages: "external",
	});
	if (!result.success || !fs.existsSync(outPath)) {
		return false;
	}
	rewriteHostImportsInFile(outPath);
	return true;
}

function rewriteHostImportsInFile(outPath: string): void {
	const aliases = getHostAliases();
	let text = fs.readFileSync(outPath, "utf8");
	const ids = Object.keys(aliases).sort((a, b) => b.length - a.length);
	for (const id of ids) {
		const href = JSON.stringify(pathToFileURL(aliases[id]).href);
		text = text.replaceAll(`"${id}"`, href).replaceAll(`'${id}'`, href);
	}
	fs.writeFileSync(outPath, text);
}

function compileWithStrip(sourcePath: string, outPath: string, inFlight: Set<string>): void {
	if (inFlight.has(sourcePath)) {
		return;
	}
	inFlight.add(sourcePath);
	const source = fs.readFileSync(sourcePath, "utf8");
	const transformed = isTypeScriptExtensionPath(sourcePath) ? transpileToEsm(source, sourcePath) : source;
	const rewritten = rewriteSpecifiers(transformed, sourcePath, inFlight);
	fs.writeFileSync(outPath, rewritten);
}

function transpileToEsm(source: string, filename: string): string {
	const stripTypeScriptTypes = nodeModule.stripTypeScriptTypes;
	if (typeof stripTypeScriptTypes !== "function") {
		throw new Error(`No TypeScript transpiler available for ${filename}`);
	}
	return stripTypeScriptTypes(source, { mode: "transform", sourceUrl: filename });
}

function rewriteSpecifiers(code: string, fromFile: string, inFlight: Set<string>): string {
	const requireFrom = createRequire(fromFile);
	const aliases = getHostAliases();
	return code.replace(SPECIFIER_RE, (full, specifier: string) => {
		return full.replace(specifier, rewriteSpecifier(specifier, fromFile, requireFrom, aliases, inFlight));
	});
}

function rewriteSpecifier(
	specifier: string,
	fromFile: string,
	requireFrom: NodeJS.Require,
	aliases: Record<string, string>,
	inFlight: Set<string>,
): string {
	if (specifier.startsWith("node:") || specifier.startsWith("file:") || specifier.startsWith("data:")) {
		return specifier;
	}
	const aliased = aliases[specifier];
	if (aliased) {
		return pathToFileURL(aliased).href;
	}
	if (specifier.startsWith(".")) {
		const resolved = resolveRelative(fromFile, specifier);
		if (!resolved) {
			return specifier;
		}
		if (isTypeScriptExtensionPath(resolved)) {
			const compiled = compiledExtensionPath(resolved);
			if (!isCompiledFresh(resolved, compiled)) {
				compileWithStrip(resolved, compiled, inFlight);
			}
			return pathToFileURL(compiled).href;
		}
		if (JS_FILE.test(resolved) || fs.existsSync(resolved)) {
			return pathToFileURL(resolved).href;
		}
	}
	try {
		return pathToFileURL(requireFrom.resolve(specifier)).href;
	} catch {
		return specifier;
	}
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
	const base = path.resolve(path.dirname(fromFile), specifier);
	if (fs.existsSync(base) && fs.statSync(base).isFile()) {
		return base;
	}
	return [
		`${base}.ts`,
		`${base}.js`,
		`${base}.mts`,
		`${base}.mjs`,
		path.join(base, "index.ts"),
		path.join(base, "index.js"),
	].find((candidate) => fs.existsSync(candidate));
}

function getHostAliases(): Record<string, string> {
	if (hostAliases) {
		return hostAliases;
	}
	const require = createRequire(import.meta.url);
	const resolveId = (id: string): string | undefined => {
		try {
			return require.resolve(id);
		} catch {
			return undefined;
		}
	};
	const aliases: Record<string, string> = {};
	const set = (id: string, resolved: string | undefined) => {
		if (resolved) {
			aliases[id] = resolved;
		}
	};
	const piCodingAgent = resolveId("@earendil-works/pi-coding-agent");
	const piAgentCore = resolveId("@earendil-works/pi-agent-core");
	const piTui = resolveId("@earendil-works/pi-tui");
	const piAiCompat = resolveId("@earendil-works/pi-ai/compat") ?? resolveId("@earendil-works/pi-ai");
	const piAiOauth = resolveId("@earendil-works/pi-ai/oauth");
	const piAiProviders = resolveId("@earendil-works/pi-ai/providers/all");
	const typebox = resolveId("typebox");
	const typeboxCompile = resolveId("typebox/compile");
	const typeboxValue = resolveId("typebox/value");
	set("@earendil-works/pi-coding-agent", piCodingAgent);
	set("@earendil-works/pi-agent-core", piAgentCore);
	set("@earendil-works/pi-tui", piTui);
	set("@earendil-works/pi-ai", piAiCompat);
	set("@earendil-works/pi-ai/compat", piAiCompat);
	set("@earendil-works/pi-ai/oauth", piAiOauth);
	set("@earendil-works/pi-ai/providers/all", piAiProviders);
	set("@mariozechner/pi-coding-agent", piCodingAgent);
	set("@mariozechner/pi-agent-core", piAgentCore);
	set("@mariozechner/pi-tui", piTui);
	set("@mariozechner/pi-ai", piAiCompat);
	set("@mariozechner/pi-ai/compat", piAiCompat);
	set("@mariozechner/pi-ai/oauth", piAiOauth);
	set("@mariozechner/pi-ai/providers/all", piAiProviders);
	set("typebox", typebox);
	set("typebox/compile", typeboxCompile);
	set("typebox/value", typeboxValue);
	set("@sinclair/typebox", typebox);
	set("@sinclair/typebox/compile", typeboxCompile);
	set("@sinclair/typebox/value", typeboxValue);
	hostAliases = aliases;
	return aliases;
}
