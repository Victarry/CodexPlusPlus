"""Read-only SSH stdio collector. Returns projected metadata, never message/tool bodies."""
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import quote
import uuid

try:
    import tomllib
except ImportError:
    tomllib = None

SCAN_BYTES = 8 * 1024 * 1024
LINE_LIMIT = 256 * 1024
RECORD_LIMIT = 512
UUID = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
PROFILE = re.compile(r"^\.codex(?:[-_][a-zA-Z0-9_-]+)?$")
USAGE_KEYS = ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens")
BOUNDARIES = {"task_started", "turn_started", "task_complete", "turn_complete", "turn_completed", "task_failed", "turn_aborted", "task_aborted"}


def text(value, limit=500):
    return value if isinstance(value, str) and len(value.encode("utf-8")) <= limit else None


def gap(prefix):
    return {"type": "usage_scan_gap", "payload": {
        "models": b'"token_count"' in prefix,
        "turns": b'"turn_context"' in prefix,
        "tools": b'_call"' in prefix,
    }}


def project(line):
    if not any(kind in line for kind in (b'"event_msg"', b'"turn_context"', b'"response_item"')):
        return None
    try:
        value = json.loads(line)
        payload = value.get("payload") or {}
        kind = payload.get("type")
        out = {"type": value.get("type"), "payload": {}}
        if out["type"] == "turn_context":
            out["payload"] = {"turn_id": text(payload.get("turn_id"), 256)}
        elif out["type"] == "event_msg" and kind in BOUNDARIES:
            out["payload"] = {"type": kind, "turn_id": text(payload.get("turn_id"), 256)}
        elif out["type"] == "event_msg" and kind == "token_count":
            info = payload.get("info") or {}
            projected = {}
            for name in ("last_token_usage", "total_token_usage"):
                usage = info.get(name) or {}
                projected[name] = {key: usage[key] for key in USAGE_KEYS if isinstance(usage.get(key), int) and not isinstance(usage[key], bool) and 0 <= usage[key] <= (1 << 63) - 1}
            window = info.get("model_context_window")
            if isinstance(window, int) and 0 <= window <= (1 << 63) - 1:
                projected["model_context_window"] = window
            out["payload"] = {"type": kind, "turn_id": text(payload.get("turn_id"), 256), "info": projected}
        elif out["type"] == "response_item" and isinstance(kind, str) and kind.endswith("_call"):
            out["payload"] = {"type": text(kind, 64), "call_id": text(payload.get("call_id")), "id": text(payload.get("id"))}
        else:
            return None
        out["timestamp"] = text(value.get("timestamp"), 80)
        return out
    except (ValueError, AttributeError, TypeError):
        return {"type": "usage_scan_gap", "payload": {"models": True, "turns": True, "tools": True}}


class Reader:
    def __init__(self, path):
        self.path = path
        self.clear()

    def clear(self):
        self.token = uuid.uuid4().hex
        self.offset = 0
        self.identity = None
        self.modified = None
        self.head = b""
        self.tail = b""
        self.pending = b""
        self.skipping = False
        self.pending_gap = None
        self.fresh = True

    def poll(self):
        records = []
        with self.path.open("rb") as handle:
            stat = os.fstat(handle.fileno())
            identity = (stat.st_dev, stat.st_ino)
            rewritten = self.identity is not None and (identity != self.identity or stat.st_size < self.offset or stat.st_size == self.offset and stat.st_mtime_ns != self.modified)
            if not rewritten and self.head:
                handle.seek(0)
                rewritten = handle.read(len(self.head)) != self.head
            if not rewritten and self.tail:
                handle.seek(self.offset - len(self.tail))
                rewritten = handle.read(len(self.tail)) != self.tail
            if rewritten:
                self.clear()
            reset = self.fresh
            self.fresh = False
            self.identity = identity
            handle.seek(self.offset)
            remaining = min(SCAN_BYTES, max(0, stat.st_size - self.offset))
            while remaining > 0 and len(records) < RECORD_LIMIT:
                chunk = handle.readline(min(remaining, LINE_LIMIT + 1))
                if not chunk:
                    break
                self.offset += len(chunk)
                remaining -= len(chunk)
                if self.skipping:
                    if chunk.endswith(b"\n"):
                        records.append(self.pending_gap)
                        self.skipping = False
                        self.pending_gap = None
                    continue
                data = self.pending + chunk
                self.pending = b""
                if len(data) > LINE_LIMIT:
                    marker = gap(data[:LINE_LIMIT])
                    if chunk.endswith(b"\n"):
                        records.append(marker)
                    else:
                        self.skipping = True
                        self.pending_gap = marker
                elif chunk.endswith(b"\n"):
                    value = project(data)
                    if value is not None:
                        records.append(value)
                else:
                    self.pending = data
            handle.seek(0)
            self.head = handle.read(min(256, self.offset))
            handle.seek(max(0, self.offset - 256))
            self.tail = handle.read(min(256, self.offset))
            self.modified = stat.st_mtime_ns
        return {"reader_id": self.token, "reset": reset, "complete": self.offset >= stat.st_size, "records": records}


class Collector:
    def __init__(self, user_home, codex_home):
        self.user_home = Path(user_home).resolve()
        self.home = Path(codex_home).resolve()
        self.readers = {}

    def sqlite_home(self):
        config = self.home / "config.toml"
        if not config.exists():
            return self.home
        source = config.read_text()
        if tomllib:
            value = tomllib.loads(source).get("sqlite_home", str(self.home))
        else:
            # Older Python fallback: only this top-level string is needed, never auth/provider fields.
            value = str(self.home)
            for line in source.splitlines():
                if line.strip().startswith("["):
                    break
                match = re.match(r"\s*sqlite_home\s*=\s*(\"(?:\\.|[^\"])*\"|'[^']*')\s*(?:#.*)?$", line)
                if match:
                    raw = match.group(1)
                    value = raw[1:-1] if raw.startswith("'") else json.loads(raw)
        target = Path(value).expanduser().resolve()
        if not self.inside(target, self.home):
            raise ValueError("sqlite_outside_profile")
        return target

    @staticmethod
    def inside(path, root):
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False

    def allowed_rollout(self, path):
        try:
            path = Path(path).resolve(strict=True)
            roots = [self.home / "sessions", self.home / "archived_sessions"]
            if path.is_file() and path.suffix == ".jsonl" and any(self.inside(root.resolve(), self.home) and self.inside(path, root.resolve()) for root in roots):
                return path
        except OSError:
            pass
        return None

    def rollout(self, session_id):
        for dbpath in sorted(self.sqlite_home().glob("state_*.sqlite"), reverse=True)[:16]:
            if not self.inside(dbpath.resolve(), self.home):
                continue
            try:
                with sqlite3.connect("file:" + quote(str(dbpath)) + "?mode=ro", uri=True, timeout=0.2) as db:
                    row = db.execute("SELECT rollout_path FROM threads WHERE id = ?", (session_id,)).fetchone()
                if row and row[0]:
                    path = self.allowed_rollout(row[0])
                    if path:
                        return path
            except sqlite3.Error:
                continue
        budget = 8192
        pending = [(self.home / name, 0) for name in ("sessions", "archived_sessions")]
        suffix = "-" + session_id + ".jsonl"
        while pending and budget > 0:
            directory, depth = pending.pop()
            if not self.inside(directory.resolve(), self.home):
                continue
            try:
                for entry in directory.iterdir():
                    budget -= 1
                    if budget < 0:
                        break
                    if entry.is_symlink():
                        continue
                    if entry.is_dir() and depth < 3:
                        pending.append((entry, depth + 1))
                    elif entry.name.endswith(suffix):
                        path = self.allowed_rollout(entry)
                        if path:
                            return path
            except OSError:
                continue
        return None

    def request(self, request):
        profile = request.get("profile_dir", "")
        if not PROFILE.fullmatch(profile) or self.home != (self.user_home / profile).resolve():
            return {"status": "profile_mismatch"}
        session_id = request.get("session_id", "")
        if not isinstance(session_id, str) or not UUID.fullmatch(session_id):
            return {"status": "invalid_session"}
        path = self.rollout(session_id)
        if path is None:
            return {"status": "not_found"}
        reader = self.readers.pop(session_id, None)
        if reader is None or reader.path != path or request.get("reader_id") != reader.token:
            reader = Reader(path)
        self.readers[session_id] = reader
        while len(self.readers) > 32:
            self.readers.pop(next(iter(self.readers)))
        result = reader.poll()
        result.update({"status": "ok", "session_id": session_id, "profile_dir": profile})
        return result


def main():
    user_home = Path.home()
    collector = Collector(user_home, os.environ.get("CODEX_HOME", str(user_home / ".codex")))
    while True:
        line = sys.stdin.buffer.readline(4097)
        if not line:
            break
        if len(line) > 4096:
            break
        request = {}
        try:
            request = json.loads(line)
            result = collector.request(request)
        except Exception:
            result = {"status": "collector_error"}
        result["id"] = request.get("id") if isinstance(request, dict) else None
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
