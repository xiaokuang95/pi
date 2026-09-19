import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	compiledExtensionPath,
	compileExtensionToJs,
	compileTypeScriptExtensionEntries,
	isTypeScriptExtensionPath,
} from "../src/core/extensions/compile.ts";

describe("extension compile", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function setup(): string {
		tempDir = mkdtempSync(join(tmpdir(), "pi-ext-compile-"));
		return tempDir;
	}

	it("identifies TypeScript extension paths", () => {
		expect(isTypeScriptExtensionPath("foo.ts")).toBe(true);
		expect(isTypeScriptExtensionPath("foo.js")).toBe(false);
		expect(isTypeScriptExtensionPath("foo.d.ts")).toBe(false);
	});

	it("compiles a TypeScript factory beside the source", async () => {
		const srcDir = setup();
		const sourcePath = join(srcDir, "ext.ts");
		writeFileSync(
			sourcePath,
			`
				const label: string = "ok";
				export default function (pi: unknown) {
					return label;
				}
			`,
		);

		const jsPath = await compileExtensionToJs(sourcePath);
		expect(jsPath).toBe(compiledExtensionPath(sourcePath));
		expect(existsSync(jsPath)).toBe(true);

		const mod = await import(pathToFileURL(jsPath).href);
		expect(typeof mod.default).toBe("function");
		expect(mod.default()).toBe("ok");
	});

	it("reuses the sidecar until the source changes", async () => {
		const srcDir = setup();
		const sourcePath = join(srcDir, "ext.ts");
		writeFileSync(sourcePath, `export default function () { return 1; }\n`);

		const first = await compileExtensionToJs(sourcePath);
		const firstBytes = readFileSync(first);
		const second = await compileExtensionToJs(sourcePath);
		expect(second).toBe(first);
		expect(readFileSync(second).equals(firstBytes)).toBe(true);

		writeFileSync(sourcePath, `export default function () { return 2; }\n`);
		const third = await compileExtensionToJs(sourcePath);
		const mod = await import(`${pathToFileURL(third).href}?t=${Date.now()}`);
		expect(mod.default()).toBe(2);
	});

	it("compiles relative TypeScript imports", async () => {
		const srcDir = setup();
		writeFileSync(join(srcDir, "helper.ts"), `export const n: number = 7;\n`);
		const sourcePath = join(srcDir, "ext.ts");
		writeFileSync(
			sourcePath,
			`
				import { n } from "./helper.ts";
				export default function () {
					return n;
				}
			`,
		);

		const jsPath = await compileExtensionToJs(sourcePath);
		const mod = await import(pathToFileURL(jsPath).href);
		expect(mod.default()).toBe(7);
	});

	it("rewrites typebox to a file URL", async () => {
		const srcDir = setup();
		const sourcePath = join(srcDir, "ext.ts");
		writeFileSync(
			sourcePath,
			`
				import { Type } from "typebox";
				export default function () {
					return Type.String();
				}
			`,
		);

		const jsPath = await compileExtensionToJs(sourcePath);
		const compiled = readFileSync(jsPath, "utf8");
		expect(compiled.includes("file:") || compiled.includes("typebox")).toBe(true);

		const mod = await import(pathToFileURL(jsPath).href);
		expect(mod.default().type).toBe("string");
	});

	it("skips JavaScript entries at install time", async () => {
		const srcDir = setup();
		const jsPath = join(srcDir, "ext.js");
		writeFileSync(jsPath, `export default function () {}\n`);
		await compileTypeScriptExtensionEntries([jsPath]);
		expect(existsSync(compiledExtensionPath(jsPath))).toBe(false);
	});
});
