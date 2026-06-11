import assert from "node:assert/strict";

export function assertMatchesAll(text: string, patterns: RegExp[]): void {
	for (const pattern of patterns) assert.match(text, pattern);
}

export function assertIncludesAll(text: string, values: string[]): void {
	for (const value of values) assert.ok(text.includes(value), `expected text to include ${value}`);
}

export function assertExcludesAll(text: string, values: string[]): void {
	for (const value of values) assert.equal(text.includes(value), false, `expected text not to include ${value}`);
}
