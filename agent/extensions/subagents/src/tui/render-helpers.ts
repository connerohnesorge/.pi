import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

export function row(content: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const singleLine = content.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
	const clipped = truncateToWidth(singleLine, innerW);
	return theme.fg("border", "│") + pad(clipped, innerW) + theme.fg("border", "│");
}
