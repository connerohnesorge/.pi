import * as fs from "node:fs";
import * as path from "node:path";
function worktreeMarkerFile(repoRoot, pid = process.pid) {
    return path.join(repoRoot, ".pi", `worktree-active-${pid}.json`);
}
function isWorktreeInfo(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return (typeof candidate.path === "string" &&
        typeof candidate.branch === "string" &&
        typeof candidate.repoRoot === "string" &&
        candidate.pid === process.pid);
}
export function readWorktreeMarker(repoRoot) {
    try {
        const parsed = JSON.parse(fs.readFileSync(worktreeMarkerFile(repoRoot), "utf-8"));
        const info = isWorktreeInfo(parsed) ? parsed : null;
        return info?.repoRoot === repoRoot ? info : null;
    }
    catch {
        return null;
    }
}
export function saveWorktreeMarker(repoRoot, info) {
    const markerPath = worktreeMarkerFile(repoRoot);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(info, null, 2));
}
export function removeWorktreeMarker(repoRoot) {
    try {
        fs.unlinkSync(worktreeMarkerFile(repoRoot));
    }
    catch { }
}
