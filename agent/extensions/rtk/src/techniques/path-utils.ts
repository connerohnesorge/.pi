function detectPathSeparator(path: string): "/" | "\\" {
	return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function detectPathPrefix(path: string, separator: "/" | "\\"): string {
	if (/^[A-Za-z]:[\\/]/.test(path)) {
		return `${path.slice(0, 2)}${separator}`;
	}

	if (path.startsWith("\\\\") || path.startsWith("//")) {
		const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
		if (parts.length >= 2) {
			return `${separator}${separator}${parts[0]}${separator}${parts[1]}${separator}`;
		}
		return `${separator}${separator}`;
	}

	if (path.startsWith("/") || path.startsWith("\\")) {
		return separator;
	}

	return "";
}

function joinPathSegments(prefix: string, separator: "/" | "\\", segments: string[]): string {
	if (segments.length === 0) {
		return prefix || "";
	}

	const joined = segments.join(separator);
	return prefix ? `${prefix}${joined}` : joined;
}

function compactPathCandidates(
	path: string,
	prefix: string,
	separator: "/" | "\\",
	segments: string[],
	maxLength: number,
): string[] {
	const lastSegment = segments[segments.length - 1] ?? path.slice(-(maxLength - 1));
	const previous = segments[segments.length - 2];
	const previousAndLast = previous ? [previous, lastSegment] : [lastSegment];

	return [
		joinPathSegments(prefix, separator, ["…", ...previousAndLast]),
		joinPathSegments("", separator, ["…", ...previousAndLast]),
		joinPathSegments("", separator, ["…", lastSegment]),
		`…${path.slice(-(maxLength - 1))}`,
		`…${lastSegment.slice(-(maxLength - 1))}`,
	];
}

function firstFittingCandidate(candidates: string[], maxLength: number): string {
	return candidates.find((candidate) => candidate.length <= maxLength) ?? candidates[candidates.length - 1] ?? "";
}

export function compactPath(path: string, maxLength: number): string {
	if (path.length <= maxLength) {
		return path;
	}

	if (maxLength < 2) {
		return path.slice(0, maxLength);
	}

	const separator = detectPathSeparator(path);
	const prefix = detectPathPrefix(path, separator);
	const segments = path
		.slice(prefix.length)
		.split(/[\\/]+/)
		.filter((segment) => segment.length > 0);

	return firstFittingCandidate(compactPathCandidates(path, prefix, separator, segments, maxLength), maxLength);
}
