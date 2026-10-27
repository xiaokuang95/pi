import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const COPILOT_413 = 'github-copilot API error (413): {"message":"failed to parse request","code":""}';
const REQUEST_LIMIT = 32 * 1024 * 1024;
const RECENT_PROMPT = "Continue the task using the recent notes.";

/** 1x1 PNG header plus padding so token estimates stay tiny while the JSON payload exceeds Copilot's 32MB limit. */
function largePngPayload(): string {
	const header = Buffer.alloc(24);
	header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	header.writeUInt32BE(13, 8);
	header.write("IHDR", 12);
	header.writeUInt32BE(1, 16);
	header.writeUInt32BE(1, 20);
	return Buffer.concat([header, Buffer.alloc(384 * 1024)]).toString("base64");
}

function seedImageHistory(harness: Harness, imageData: string): void {
	const timestamp = Date.now() - 10_000;
	const model = harness.getModel();
	harness.sessionManager.appendMessage({ role: "user", content: "Review the old images", timestamp });
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage(fauxToolCall("read", { path: "old-images" }, { id: "read-images" }), {
			stopReason: "toolUse",
			timestamp,
		}),
		provider: model.provider,
		api: model.api,
		model: model.id,
	});
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "read-images",
		toolName: "read",
		content: Array.from(
			{ length: 89 },
			(): ImageContent => ({
				type: "image",
				mimeType: "image/png",
				data: imageData,
			}),
		),
		isError: false,
		timestamp,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("Finished reviewing the old images", { timestamp }),
		provider: model.provider,
		api: model.api,
		model: model.id,
	});
	// Keep a completed recent turn so recovery does not summarize the entire current
	// request when it omits the failed assistant attempt. The old images are outside
	// the default 20k-token retained tail.
	harness.sessionManager.appendMessage({
		role: "user",
		content: `Recent task notes: ${"x".repeat(80_000)}`,
		timestamp,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("Ready to continue", { timestamp }),
		provider: model.provider,
		api: model.api,
		model: model.id,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("Copilot request-size overflow recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("compacts an image-heavy history and retries after the real 413", async () => {
		const harness = await createHarness({
			provider: "github-copilot",
			models: [{ id: "faux-copilot", contextWindow: 1_000_000 }],
		});
		harnesses.push(harness);
		seedImageHistory(harness, largePngPayload());
		harness.setResponses([
			(context) => {
				expect(Buffer.byteLength(JSON.stringify(context))).toBeGreaterThan(REQUEST_LIMIT);
				// Throwing produces the zero-usage error seen in the affected session.
				throw new Error(COPILOT_413);
			},
			// The overflow recovery summarization runs on the compacted, image-free context.
			() => fauxAssistantMessage("The old images have been reviewed. Continue with the recent task."),
			(context) => {
				// The retried request no longer carries the images, so it stays under the byte limit.
				expect(JSON.stringify(context)).not.toContain('"type":"image"');
				return fauxAssistantMessage("Continued after compaction");
			},
		]);

		await harness.session.prompt(RECENT_PROMPT);

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "overflow" }]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		// The session continued to a final answer instead of dying on the 413.
		expect(harness.session.getLastAssistantText()).toBe("Continued after compaction");
	});
});
