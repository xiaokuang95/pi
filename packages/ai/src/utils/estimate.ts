import type { AssistantMessage, ImageContent, Message, TextContent, TranscriptContext, Usage } from "../types.ts";
import { getSystemMessageText } from "./text.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

const CHARS_PER_TOKEN = 3.5;
/** Anthropic vision: tokens ≈ width × height / 750. Higher than OpenAI's tile formula, so safer against overflow. */
const IMAGE_PIXELS_PER_TOKEN = 750;
/** Bytes of decoded payload used to read PNG/GIF/WebP/JPEG headers. JPEG SOF can sit after a large EXIF block. */
const IMAGE_HEADER_BYTES = 64 * 1024;

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function imagePayload(data: string): string {
	if (!data.startsWith("data:")) return data;
	const comma = data.indexOf(",");
	return comma >= 0 ? data.slice(comma + 1) : data;
}

function decodeBase64Prefix(data: string, maxBytes: number): Uint8Array | undefined {
	const charCount = Math.min(data.length, Math.ceil(maxBytes / 3) * 4);
	const aligned = charCount - (charCount % 4);
	if (aligned <= 0) return undefined;
	try {
		const binary = atob(data.slice(0, aligned));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return undefined;
	}
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8);
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] ?? 0) * 0x1000000 +
		((bytes[offset + 1] ?? 0) << 16) +
		((bytes[offset + 2] ?? 0) << 8) +
		(bytes[offset + 3] ?? 0)
	);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] ?? 0) +
		((bytes[offset + 1] ?? 0) << 8) +
		((bytes[offset + 2] ?? 0) << 16) +
		(bytes[offset + 3] ?? 0) * 0x1000000
	);
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
	if (bytes.length < offset + text.length) return false;
	for (let i = 0; i < text.length; i++) {
		if (bytes[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
	for (let offset = 2; offset + 9 <= bytes.length; ) {
		if (bytes[offset] !== 0xff) return undefined;
		const marker = bytes[offset + 1]!;
		if (marker === 0xff) {
			offset++;
			continue;
		}
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { width: readUint16BE(bytes, offset + 7), height: readUint16BE(bytes, offset + 5) };
		}
		const segmentLength = readUint16BE(bytes, offset + 2);
		const next = offset + 2 + segmentLength;
		if (next <= offset || next > bytes.length) return undefined;
		offset = next;
	}
	return undefined;
}

function imageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
	switch (mimeType) {
		case "image/png":
			if (bytes.length < 24 || !startsWithAscii(bytes, 12, "IHDR")) return undefined;
			return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
		case "image/gif":
			return bytes.length < 10 ? undefined : { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
		case "image/webp":
			if (bytes.length < 30) return undefined;
			if (startsWithAscii(bytes, 12, "VP8 ")) {
				return { width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
			}
			if (startsWithAscii(bytes, 12, "VP8L")) {
				const bits = readUint32LE(bytes, 21);
				return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
			}
			if (startsWithAscii(bytes, 12, "VP8X")) {
				const uint24 = (offset: number): number => readUint16LE(bytes, offset) + ((bytes[offset + 2] ?? 0) << 16);
				return { width: uint24(24) + 1, height: uint24(27) + 1 };
			}
			return undefined;
		case "image/jpeg":
		case "image/jpg":
			return jpegDimensions(bytes);
		default:
			return undefined;
	}
}

function sniffImageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return imageDimensions(bytes, "image/png");
	}
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return imageDimensions(bytes, "image/jpeg");
	if (startsWithAscii(bytes, 0, "GIF87a") || startsWithAscii(bytes, 0, "GIF89a")) {
		return imageDimensions(bytes, "image/gif");
	}
	if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) {
		return imageDimensions(bytes, "image/webp");
	}
	return undefined;
}

function estimateImageTokens(image: ImageContent): number {
	const payload = imagePayload(image.data);
	const bytes = decodeBase64Prefix(payload, IMAGE_HEADER_BYTES);
	const mime = image.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	const size = (bytes && imageDimensions(bytes, mime)) || (bytes && sniffImageDimensions(bytes));
	if (size && size.width > 0 && size.height > 0) {
		return Math.max(1, Math.ceil((size.width * size.height) / IMAGE_PIXELS_PER_TOKEN));
	}
	return Math.max(1, estimateTextTokens(payload));
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return estimateTextTokens(content);

	let tokens = 0;
	let textChars = 0;
	for (const block of content) {
		if (block.type === "text") textChars += block.text.length;
		else tokens += estimateImageTokens(block);
	}
	return tokens + Math.ceil(textChars / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
	let chars = 0;

	if (message.role === "system") {
		return (
			estimateTextTokens(getSystemMessageText(message)) +
			estimateToolsTokens(message.toolsAdded) +
			estimateToolsTokens(message.toolsRemoved)
		);
	}
	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	const messages = "messages" in context ? context.messages : context;
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}
