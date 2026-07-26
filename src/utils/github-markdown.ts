/**
 * GitHub-flavored Markdown builders for PR bodies, job summaries and check-run
 * output.
 *
 * These replace `GithubMarkdown` from the deleted
 * `@savvy-web/github-action-effects`. The `@effected` kit deliberately ships no
 * successor: report shaping is consumer policy, so the strings a given action
 * emits belong to that action. They are pure string builders with no service
 * dependency, which is why they live in `utils/` rather than `services/`.
 *
 * @module utils/github-markdown
 */

/** Escape the two characters that would break out of a table cell. */
const escapeCell = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

/** An ATX heading at `level` (1–6). */
export const heading = (text: string, level = 2): string => `${"#".repeat(level)} ${text}`;

/** Inline code span. */
export const code = (text: string): string => `\`${text}\``;

/** Bold (strong) text. */
export const bold = (text: string): string => `**${text}**`;

/** An inline link. */
export const link = (text: string, url: string): string => `[${text}](${url})`;

/** A horizontal rule. */
export const rule = (): string => "---";

/** An unordered list, one item per line. */
export const list = (items: ReadonlyArray<string>): string => items.map((item) => `- ${item}`).join("\n");

/**
 * A fenced code block.
 *
 * The fence grows past any backtick run inside `text`, so content that itself
 * contains a fence cannot terminate the block early.
 */
export const codeBlock = (text: string, language = ""): string => {
	const longestRun = [...text.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return `${fence}${language}\n${text}\n${fence}`;
};

/**
 * A collapsible `<details>` block.
 *
 * The blank lines around the body are required: without them GitHub renders the
 * Markdown inside the block as literal text.
 */
export const details = (summary: string, content: string): string =>
	`<details>\n<summary>${summary}</summary>\n\n${content}\n\n</details>`;

/**
 * A GFM table. Returns an empty string when there are no rows, so a caller can
 * push the result unconditionally without emitting a headers-only table.
 */
export const table = (headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string => {
	if (rows.length === 0) return "";
	const headerLine = `| ${headers.map(escapeCell).join(" | ")} |`;
	const separator = `| ${headers.map(() => "---").join(" | ")} |`;
	const bodyLines = rows.map((row) => `| ${row.map((cell) => escapeCell(cell ?? "")).join(" | ")} |`);
	return [headerLine, separator, ...bodyLines].join("\n");
};

/**
 * The builders as one namespace object, matching the destructuring call style
 * the report service already uses.
 */
export const GithubMarkdown = {
	heading,
	code,
	bold,
	link,
	rule,
	list,
	codeBlock,
	details,
	table,
} as const;
