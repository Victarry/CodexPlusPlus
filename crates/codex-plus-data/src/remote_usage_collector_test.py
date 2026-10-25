"""Collector integration contract, invoked by cargo test with the collector namespace."""
import tempfile

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    home = root / ".codex"
    sessions = home / "sessions"
    sessions.mkdir(parents=True)
    sid = "00000000-0000-0000-0000-000000000001"
    path = sessions / ("rollout-" + sid + ".jsonl")
    collector = Collector(root, home)
    request = {"profile_dir": ".codex", "session_id": sid}
    assert collector.request(request)["status"] == "not_found"
    assert collector.request(dict(request, session_id="../../other"))["status"] == "invalid_session"
    line = json.dumps({"type": "response_item", "payload": {"type": "function_call", "call_id": "tool", "arguments": "PRIVATE"}}).encode()
    path.write_bytes(line[:40])
    first = collector.request(request)
    assert first["reset"] and first["complete"] and first["records"] == []
    request["reader_id"] = first["reader_id"]
    with path.open("ab") as f:
        f.write(line[40:] + b"\n")
    next_ = collector.request(request)
    assert not next_["reset"] and len(next_["records"]) == 1
    assert "PRIVATE" not in json.dumps(next_)
    assert collector.request(request)["records"] == []
    # Same path with a different inode must reset its generation and replay.
    replacement = path.with_suffix(".next")
    replacement.write_bytes(line + b"\n")
    replacement.replace(path)
    replaced = collector.request(request)
    assert replaced["reset"] and replaced["reader_id"] != first["reader_id"]
    request["reader_id"] = replaced["reader_id"]
    # Oversized rows never transfer bodies; incomplete model metadata marks a gap.
    path.write_bytes(b'{"type":"event_msg","payload":{"type":"token_count","padding":"' + b"x" * (LINE_LIMIT + 1) + b'"}}\n' + line + b"\n")
    oversized = collector.request(request)
    assert oversized["records"][0]["type"] == "usage_scan_gap"
    assert oversized["records"][0]["payload"]["models"]
    assert len(oversized["records"]) == 2
    # Record cap yields bounded batches that can be resumed without dropping rows.
    path.write_bytes((line + b"\n") * (RECORD_LIMIT + 3))
    limited = collector.request(request)
    assert len(limited["records"]) == RECORD_LIMIT and not limited["complete"]
    request["reader_id"] = limited["reader_id"]
    final = collector.request(request)
    assert len(final["records"]) == 3 and final["complete"] and not final["reset"]
    # No DB available is supported through bounded session discovery.
    assert collector.rollout(sid) == path.resolve()
    # Symlink roots and DB-provided paths may never escape the requested profile.
    other = root / ".codex-kth"
    other.mkdir()
    outside = other / "private.jsonl"
    outside.write_bytes(line + b"\n")
    assert collector.allowed_rollout(outside) is None
    link = home / "archived_sessions"
    link.symlink_to(other, target_is_directory=True)
    assert collector.allowed_rollout(link / "private.jsonl") is None
    db = sqlite3.connect(home / "state_5.sqlite")
    db.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)")
    missing = "00000000-0000-0000-0000-000000000002"
    db.execute("INSERT INTO threads VALUES (?,?)", (missing, str(outside)))
    db.commit()
    db.close()
    assert collector.rollout(missing) is None
    (home / "config.toml").write_text('sqlite_home = "' + str(other) + '"\n')
    try:
        collector.sqlite_home()
    except ValueError:
        pass
    else:
        raise AssertionError("sqlite outside profile must be rejected")
print("collector contracts passed")
