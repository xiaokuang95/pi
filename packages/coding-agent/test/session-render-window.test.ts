import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	findSessionRenderTailStart,
	isSessionRenderBoundary,
	takeOlderSessionRenderChunk,
} from "../src/modes/interactive/interactive-mode.ts";

function user(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "0",
		message: { role: "user", content: [{ type: "text", text: id }] },
	} as unknown as SessionEntry;
}

function assistant(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "0",
		message: { role: "assistant", content: [{ type: "text", text: id }] },
	} as unknown as SessionEntry;
}

describe("session render window", () => {
	it("treats user messages as render boundaries", () => {
		expect(isSessionRenderBoundary(user("u"))).toBe(true);
		expect(isSessionRenderBoundary(assistant("a"))).toBe(false);
	});

	it("starts at 0 when the session is smaller than the tail", () => {
		expect(findSessionRenderTailStart([user("a"), assistant("b")], 48)).toBe(0);
	});

	it("aligns the tail start to a user message", () => {
		const entries = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), assistant("a3")];
		expect(findSessionRenderTailStart(entries, 2)).toBe(2);
	});

	it("chunks older entries on user-message boundaries", () => {
		const entries = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3"), assistant("a3")];
		const { chunk, rest } = takeOlderSessionRenderChunk(entries, 3);
		expect(chunk.map((entry) => entry.id)).toEqual(["u2", "a2", "u3", "a3"]);
		expect(rest.map((entry) => entry.id)).toEqual(["u1", "a1"]);
	});
});
