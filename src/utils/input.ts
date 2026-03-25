/**
 * Parse a multi-value GitHub Action input string.
 *
 * Supports multiple formats:
 * - Newline-separated: "a\nb\nc"
 * - Bullet lists: "* a\n* b\n* c"
 * - Comma-separated: "a, b, c"
 * - JSON arrays: '["a", "b", "c"]'
 * - Comment lines stripped (# prefix)
 *
 * @module utils/input
 */

export const parseMultiValueInput = (raw: string): string[] => {
	const trimmed = raw.trim();
	if (!trimmed) return [];

	// JSON array
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return parsed.map((s: unknown) => String(s).trim()).filter(Boolean);
			}
		} catch {
			// Not valid JSON, fall through to other formats
		}
	}

	// Newline or bullet list (supports # comments)
	if (trimmed.includes("\n")) {
		return trimmed
			.split("\n")
			.map((s) => s.trim().replace(/^\*\s*/, ""))
			.filter((s) => s.length > 0 && !s.startsWith("#"));
	}

	// Comma-separated
	return trimmed
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
};
