import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Model, Usage } from "../src/types.ts";
import { estimateContextTokens, estimateMessageTokens } from "../src/utils/estimate.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	// Regression for #10497: large new inputs need more room than chars/4 allows.
	it("reserves 3.5 characters per token for new text when limiting output", () => {
		const context = normalizeContext({
			messages: [createAssistant(100, 2_000), { role: "user", content: "x".repeat(3_500), timestamp: 200 }],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 3_000,
			usageTokens: 2_000,
			trailingTokens: 1_000,
			lastUsageIndex: 0,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(2_904);
	});

	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context = normalizeContext({
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_149,
			usageTokens: 0,
			trailingTokens: 1_149,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_755);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_002,
			usageTokens: 2_000,
			trailingTokens: 2,
			lastUsageIndex: 3,
		});
	});

	it("counts image tokens from pixel dimensions instead of a fixed size", () => {
		const image = { type: "image" as const, mimeType: "image/png", data: pngHeader(2000, 2000) };
		const context = normalizeContext({
			messages: [createAssistant(100, 2_000), { role: "user", content: [image], timestamp: 200 }],
		});

		expect(estimateMessageTokens({ role: "user", content: [image], timestamp: 200 })).toBe(5_334);
		expect(estimateContextTokens(context)).toEqual({
			tokens: 7_334,
			usageTokens: 2_000,
			trailingTokens: 5_334,
			lastUsageIndex: 0,
		});
	});

	it("falls back to payload size when image dimensions cannot be read", () => {
		const data = "A".repeat(3500);
		const image = { type: "image" as const, mimeType: "image/png", data };
		expect(estimateMessageTokens({ role: "user", content: [image], timestamp: 1 })).toBe(1_000);
	});

	it("reads JPEG, GIF, and data-URL PNG dimensions", () => {
		const jpeg = { type: "image" as const, mimeType: "image/jpeg", data: jpegSof(1000, 500) };
		const gif = { type: "image" as const, mimeType: "image/gif", data: gifHeader(750, 750) };
		const dataUrl = {
			type: "image" as const,
			mimeType: "image/png",
			data: `data:image/png;base64,${pngHeader(100, 100)}`,
		};
		expect(estimateMessageTokens({ role: "user", content: [jpeg], timestamp: 1 })).toBe(667);
		expect(estimateMessageTokens({ role: "user", content: [gif], timestamp: 1 })).toBe(750);
		expect(estimateMessageTokens({ role: "user", content: [dataUrl], timestamp: 1 })).toBe(14);
	});
});

function pngHeader(width: number, height: number): string {
	const bytes = Buffer.alloc(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes.toString("base64");
}

function jpegSof(width: number, height: number): string {
	return Buffer.from([
		0xff,
		0xd8,
		0xff,
		0xc0,
		0x00,
		0x0b,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x01,
		0x01,
		0x11,
		0x00,
	]).toString("base64");
}

function gifHeader(width: number, height: number): string {
	const bytes = Buffer.alloc(10);
	bytes.write("GIF89a", 0);
	bytes.writeUInt16LE(width, 6);
	bytes.writeUInt16LE(height, 8);
	return bytes.toString("base64");
}
