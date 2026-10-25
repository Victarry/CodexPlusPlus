//! 按 rollout 增量统计任务轮次和有用量记录的已完成模型调用。
//! 模型与工具请求分别计数，不把重复 token_count / 限额快照或工具输出重复累计。
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

const CACHE_LIMIT: usize = 32;
const SCAN_BYTES: u64 = 8 * 1024 * 1024;
const LINE_LIMIT: usize = 256 * 1024;
const TURN_LIMIT: usize = 100_000;
const TOOL_LIMIT: usize = 200_000;

const TOOL_KINDS: [&str; 6] = [
    "function_call",
    "custom_tool_call",
    "local_shell_call",
    "tool_search_call",
    "web_search_call",
    "image_generation_call",
];

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Activity {
    pub scan_complete: bool,
    pub turns: Option<u64>,
    pub turn_calls: Option<u64>,
    pub total_calls: u64,
    pub calls_complete: bool,
    pub turn_tool_calls: Option<u64>,
    pub total_tool_calls: u64,
    pub tool_calls_complete: bool,
}

#[derive(Debug, Default)]
struct TurnCounts {
    model: u64,
    tools: u64,
}

#[derive(Debug, PartialEq, Eq)]
struct Identity {
    created: Option<SystemTime>,
    #[cfg(unix)]
    device_inode: (u64, u64),
}

impl Identity {
    fn of(metadata: &Metadata) -> Self {
        Self {
            created: metadata.created().ok(),
            #[cfg(unix)]
            device_inode: {
                use std::os::unix::fs::MetadataExt;
                (metadata.dev(), metadata.ino())
            },
        }
    }
}

#[derive(Debug, Default)]
struct Scanner {
    identity: Option<Identity>,
    modified: Option<SystemTime>,
    offset: u64,
    head: Vec<u8>,
    tail: Vec<u8>,
    line: Vec<u8>,
    oversized: bool,
    turns: HashMap<String, TurnCounts>,
    active_turn: Option<String>,
    display_turn: Option<String>,
    total_calls: u64,
    last_usage: Option<[u64; 3]>,
    unknown_turns: bool,
    unknown_calls: bool,
    tool_ids: HashSet<String>,
    total_tool_calls: u64,
    unknown_tools: bool,
    unknown_tool_turns: bool,
}

type SharedScanner = Arc<Mutex<Scanner>>;
type Cache = VecDeque<(PathBuf, SharedScanner)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

/// 缓存按真实文件路径隔离；adapter 每次请求重建时仍复用扫描进度。
pub(crate) fn read_activity(path: &Path) -> anyhow::Result<Activity> {
    let path = path.canonicalize()?;
    let scanner = {
        let mut cache = CACHE
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let scanner = cache
            .iter()
            .position(|(key, _)| key == &path)
            .and_then(|index| cache.remove(index))
            .map(|(_, scanner)| scanner)
            .unwrap_or_default();
        cache.push_back((path.clone(), Arc::clone(&scanner)));
        while cache.len() > CACHE_LIMIT {
            cache.pop_front();
        }
        scanner
    };
    let mut scanner = scanner.lock().unwrap_or_else(|e| e.into_inner());
    scanner.advance(&mut File::open(path)?, SCAN_BYTES)
}

fn bytes_at(file: &mut File, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0; len];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

impl Scanner {
    fn advance(&mut self, file: &mut File, budget: u64) -> anyhow::Result<Activity> {
        let metadata = file.metadata()?;
        let identity = Identity::of(&metadata);
        let rewritten = self.identity.as_ref().is_some_and(|old| old != &identity)
            || metadata.len() < self.offset
            || self.offset > 0
                && metadata.len() == self.offset
                && metadata.modified().ok() != self.modified
            || !self.head.is_empty() && bytes_at(file, 0, self.head.len())? != self.head
            || !self.tail.is_empty()
                && bytes_at(file, self.offset - self.tail.len() as u64, self.tail.len())?
                    != self.tail;
        if rewritten {
            *self = Self::default();
        }
        self.identity = Some(identity);
        file.seek(SeekFrom::Start(self.offset))?;
        let mut remaining = metadata.len().saturating_sub(self.offset).min(budget);
        let mut buffer = [0_u8; 64 * 1024];
        while remaining > 0 {
            let len = buffer.len().min(remaining as usize);
            let read = file.read(&mut buffer[..len])?;
            if read == 0 {
                break;
            }
            self.feed(&buffer[..read]);
            self.offset += read as u64;
            remaining -= read as u64;
        }
        self.head = bytes_at(file, 0, self.offset.min(256) as usize)?;
        let tail_len = self.offset.min(256) as usize;
        self.tail = bytes_at(file, self.offset - tail_len as u64, tail_len)?;
        self.modified = metadata.modified().ok();
        Ok(Activity {
            scan_complete: self.offset >= metadata.len(),
            turns: (!self.unknown_turns).then_some(self.turns.len() as u64),
            turn_calls: (!self.unknown_turns)
                .then(|| {
                    self.display_turn
                        .as_ref()
                        .and_then(|id| self.turns.get(id))
                        .map(|counts| counts.model)
                })
                .flatten(),
            total_calls: self.total_calls,
            calls_complete: !self.unknown_calls,
            turn_tool_calls: (!self.unknown_turns && !self.unknown_tool_turns)
                .then(|| {
                    self.display_turn
                        .as_ref()
                        .and_then(|id| self.turns.get(id))
                        .map(|counts| counts.tools)
                })
                .flatten(),
            total_tool_calls: self.total_tool_calls,
            tool_calls_complete: !self.unknown_tools,
        })
    }

    fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if byte == b'\n' {
                if self.oversized {
                    // 超大工具/消息正文不影响计数；不能完整读取的统计事件则降级为下界。
                    if self.line.windows(13).any(|w| w == b"\"token_count\"") {
                        self.unknown_calls = true;
                    }
                    if self.active_turn.is_none()
                        && self.line.windows(14).any(|w| w == b"\"turn_context\"")
                    {
                        self.unknown_turns = true;
                    }
                    if TOOL_KINDS.iter().any(|kind| {
                        let pattern = format!("\"{kind}\"");
                        self.line
                            .windows(pattern.len())
                            .any(|part| part == pattern.as_bytes())
                    }) {
                        self.unknown_tools = true;
                    }
                } else {
                    let line = std::mem::take(&mut self.line);
                    self.record(&line);
                    self.line = line;
                }
                self.line.clear();
                self.oversized = false;
            } else if self.line.len() < LINE_LIMIT {
                self.line.push(byte);
            } else {
                self.oversized = true;
            }
        }
    }

    fn select_turn(&mut self, id: Option<&str>) {
        let Some(id) = id.filter(|id| !id.is_empty() && id.len() <= 256) else {
            self.unknown_turns = true;
            self.active_turn = None;
            self.display_turn = None;
            return;
        };
        if self.turns.len() >= TURN_LIMIT && !self.turns.contains_key(id) {
            self.unknown_turns = true;
            self.active_turn = None;
            self.display_turn = None;
            return;
        }
        self.turns.entry(id.to_owned()).or_default();
        self.active_turn = Some(id.to_owned());
        self.display_turn = self.active_turn.clone();
    }

    fn record(&mut self, bytes: &[u8]) {
        if !bytes.windows(11).any(|w| w == b"\"event_msg\"")
            && !bytes.windows(14).any(|w| w == b"\"turn_context\"")
            && !bytes.windows(15).any(|w| w == b"\"response_item\"")
        {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            self.unknown_calls = true;
            self.unknown_turns = true;
            self.unknown_tools = true;
            return;
        };
        let payload = &value["payload"];
        let turn_id = payload["turn_id"].as_str().filter(|id| !id.is_empty());
        if value["type"] == "turn_context" {
            if turn_id.is_some() {
                self.select_turn(turn_id);
            }
            return;
        }
        if value["type"] == "response_item" {
            if payload["type"]
                .as_str()
                .is_some_and(|kind| TOOL_KINDS.contains(&kind))
            {
                self.record_tool(payload);
            }
            return;
        }
        if value["type"] != "event_msg" {
            return;
        }
        match payload["type"].as_str() {
            Some("task_started" | "turn_started") => self.select_turn(turn_id),
            Some(
                "task_complete" | "turn_complete" | "turn_completed" | "task_failed"
                | "turn_aborted" | "task_aborted",
            ) => {
                if turn_id.is_some() {
                    self.select_turn(turn_id);
                }
                self.active_turn = None;
            }
            Some("token_count") => {
                if turn_id.is_some() {
                    self.select_turn(turn_id);
                }
                let info = &payload["info"];
                let last = &info["last_token_usage"];
                let total = &info["total_token_usage"];
                let input = total["input_tokens"].as_u64();
                let output = total["output_tokens"].as_u64();
                let tokens = total["total_tokens"].as_u64();
                let usage = [input.unwrap_or(0), output.unwrap_or(0), tokens.unwrap_or(0)];
                // Codex 的上下文重估 / context-full 哨兵只有 total_tokens，没有真实
                // input/output。同步累计基线，但不能把它记作一次模型调用。
                if !["input_tokens", "output_tokens"]
                    .iter()
                    .any(|key| last[*key].as_u64().is_some_and(|n| n > 0))
                {
                    if last["input_tokens"].is_null()
                        && last["output_tokens"].is_null()
                        && last["total_tokens"].as_u64().is_some_and(|n| n > 0)
                    {
                        self.unknown_calls = true;
                    }
                    if input.is_some() || output.is_some() || tokens.is_some() {
                        self.last_usage = Some(usage);
                    }
                    return;
                }
                if input.is_none() && output.is_none() && tokens.is_none() {
                    self.unknown_calls = true;
                    return;
                }
                if self.last_usage == Some(usage) {
                    return;
                }
                let reset = self.last_usage.is_some_and(|previous| {
                    usage.iter().zip(previous).any(|(next, old)| *next < old)
                });
                self.last_usage = Some(usage);
                if reset || usage == [0, 0, 0] {
                    self.unknown_calls = true;
                    return;
                }
                self.total_calls += 1;
                if let Some(calls) = self
                    .active_turn
                    .as_ref()
                    .and_then(|id| self.turns.get_mut(id))
                {
                    calls.model += 1;
                } else {
                    self.display_turn = None;
                    self.unknown_turns = true;
                }
            }
            _ => {}
        }
    }

    fn record_tool(&mut self, payload: &Value) {
        // 只读模型可见的外层请求。function/custom 输出及 item_completed 镜像均不计数。
        let mut identities = Vec::new();
        if let Some(id) = payload["call_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .filter(|id| id.len() <= 500)
        {
            identities.push(format!("call:{id}"));
        }
        if let Some(id) = payload["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 500)
        {
            identities.push(format!("item:{id}"));
        }
        if identities.is_empty() {
            self.unknown_tools = true;
            return;
        }
        let duplicate = identities.iter().any(|id| self.tool_ids.contains(id));
        let new_ids = identities
            .iter()
            .filter(|id| !self.tool_ids.contains(*id))
            .count();
        if self.tool_ids.len() + new_ids > TOOL_LIMIT {
            self.unknown_tools = true;
            return;
        }
        self.tool_ids.extend(identities);
        if duplicate {
            return;
        }
        self.total_tool_calls += 1;
        if let Some(counts) = self
            .active_turn
            .as_ref()
            .and_then(|id| self.turns.get_mut(id))
        {
            counts.tools += 1;
        } else {
            self.unknown_tool_turns = true;
            self.unknown_turns = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    fn start(id: &str) -> Value {
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":id}})
    }

    fn usage(total: u64) -> Value {
        json!({"type":"event_msg","payload":{"type":"token_count","info":{
            "total_token_usage":{"input_tokens":total*10,"output_tokens":total,"total_tokens":total*11},
            "last_token_usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}
        }}})
    }

    fn lines(records: &[Value]) -> String {
        records.iter().map(|value| format!("{value}\n")).collect()
    }

    fn read(scanner: &mut Scanner, path: &Path) -> Activity {
        scanner
            .advance(&mut File::open(path).unwrap(), SCAN_BYTES)
            .unwrap()
    }

    #[test]
    fn counts_turn_ids_and_completed_usage_without_tools_or_duplicate_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        fs::write(
            &path,
            lines(&[
                start("one"),
                json!({"type":"turn_context","payload":{"turn_id":"one"}}),
                usage(1),
                json!({"type":"response_item","payload":{"type":"function_call"}}),
                usage(1), // 限额 / 重复通知不会新增调用。
                usage(2),
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"one"}}),
                start("two"),
                usage(2),
                usage(3),
                json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"two"}}),
            ]),
        )
        .unwrap();
        let mut scanner = Scanner::default();
        let counts = read(&mut scanner, &path);
        assert_eq!(
            (counts.turns, counts.turn_calls, counts.total_calls),
            (Some(2), Some(1), 3)
        );
        assert!(counts.scan_complete && counts.calls_complete);
        assert_eq!(
            read(&mut scanner, &path).total_calls,
            3,
            "重复轮询不重复计数"
        );
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", start("three")).unwrap();
        let next = read(&mut scanner, &path);
        assert_eq!(
            (next.turns, next.turn_calls, next.total_calls),
            (Some(3), Some(0), 3)
        );
    }

    #[test]
    fn ignores_estimates_and_context_full_sentinels_but_keeps_the_usage_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        fs::write(
            &path,
            lines(&[
                start("one"),
                usage(1),
                json!({"type":"event_msg","payload":{"type":"token_count","info":{
                    "last_token_usage":{"input_tokens":0,"output_tokens":0,"total_tokens":1000},
                    "total_token_usage":{"input_tokens":0,"output_tokens":0,"total_tokens":1000}
                }}}),
                json!({"type":"event_msg","payload":{"type":"token_count","info":{
                    "last_token_usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11},
                    "total_token_usage":{"input_tokens":10,"output_tokens":1,"total_tokens":1011}
                }}}),
            ]),
        )
        .unwrap();
        let counts = read(&mut Scanner::default(), &path);
        assert_eq!(counts.total_calls, 2);
        assert_eq!(counts.turn_calls, Some(2));
        assert!(counts.calls_complete);
    }

    #[test]
    fn retains_partial_json_lines_and_bounds_initial_history_scan_and_line_memory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        write!(file, "{}", lines(&[start("one"), usage(1)])).unwrap();
        write!(
            file,
            "{}\n",
            json!({"type":"response_item","payload":{"text":"x".repeat(SCAN_BYTES as usize)}})
        )
        .unwrap();
        write!(file, "{}", usage(2)).unwrap(); // 最后一行仍在写入。
        let mut scanner = Scanner::default();
        let first = read(&mut scanner, &path);
        assert!(!first.scan_complete);
        assert_eq!(scanner.offset, SCAN_BYTES);
        assert!(scanner.line.len() <= LINE_LIMIT);
        let second = read(&mut scanner, &path);
        assert!(second.scan_complete);
        assert_eq!(second.total_calls, 1);
        writeln!(file).unwrap();
        assert_eq!(read(&mut scanner, &path).total_calls, 2);
    }

    #[test]
    fn rebuilds_after_truncation_same_length_rewrite_and_file_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        let mut scanner = Scanner::default();
        fs::write(&path, lines(&[start("one"), usage(1), usage(2)])).unwrap();
        assert_eq!(read(&mut scanner, &path).total_calls, 2);
        fs::write(&path, lines(&[start("two"), usage(1)])).unwrap();
        assert_eq!(read(&mut scanner, &path).total_calls, 1);
        fs::write(&path, lines(&[start("six"), usage(3)])).unwrap();
        assert_eq!(read(&mut scanner, &path).turns, Some(1));
        assert!(scanner.turns.contains_key("six"));
        let replacement = dir.path().join("replacement.jsonl");
        fs::write(&replacement, lines(&[start("new"), usage(1), usage(2)])).unwrap();
        fs::rename(replacement, &path).unwrap();
        let counts = read(&mut scanner, &path);
        assert_eq!((counts.turns, counts.total_calls), (Some(1), 2));
        assert!(scanner.turns.contains_key("new"));
    }

    #[test]
    fn legacy_missing_turn_ids_and_usage_resets_do_not_claim_exact_counts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        fs::write(
            &path,
            lines(&[
                usage(2),
                usage(1),
                usage(2),
                json!({"type":"event_msg","payload":{"type":"task_started"}}),
                usage(3),
            ]),
        )
        .unwrap();
        let counts = read(&mut Scanner::default(), &path);
        assert_eq!(counts.turns, None);
        assert_eq!(counts.turn_calls, None);
        assert_eq!(counts.total_calls, 3);
        assert!(!counts.calls_complete);
    }

    #[test]
    fn shared_cache_keeps_rollouts_separate_and_survives_recreated_adapters() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.jsonl");
        let b = dir.path().join("b.jsonl");
        fs::write(&a, lines(&[start("one"), usage(1)])).unwrap();
        fs::write(&b, lines(&[start("two"), usage(1), usage(2)])).unwrap();
        assert_eq!(read_activity(&a).unwrap().total_calls, 1);
        assert_eq!(read_activity(&b).unwrap().total_calls, 2);
        let mut file = OpenOptions::new().append(true).open(&a).unwrap();
        writeln!(file, "{}", usage(2)).unwrap();
        assert_eq!(read_activity(&a).unwrap().total_calls, 2);
    }

    #[test]
    fn model_and_tool_counts_are_independent_and_outputs_and_ui_mirrors_are_not_calls() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        fs::write(&path, lines(&[
            start("one"), usage(1),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"a","id":"item-a"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"a"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"a","id":"replayed-a"}}),
            json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"a"}}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"b"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"b"}}),
            json!({"type":"response_item","payload":{"type":"web_search_call","id":"web-1","status":"in_progress"}}),
            json!({"type":"response_item","payload":{"type":"web_search_call","id":"web-1","status":"completed"}}),
            start("two"),
            json!({"type":"response_item","payload":{"type":"local_shell_call","id":"shell-1"}}),
            json!({"type":"response_item","payload":{"type":"local_shell_call","id":"shell-1","call_id":"shell-call"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"failed-tool","status":"failed"}}),
            usage(2),
        ])).unwrap();
        let mut scanner = Scanner::default();
        let counts = read(&mut scanner, &path);
        assert_eq!(
            (counts.turns, counts.turn_calls, counts.total_calls),
            (Some(2), Some(1), 2)
        );
        assert_eq!(
            (counts.turn_tool_calls, counts.total_tool_calls),
            (Some(2), 5)
        );
        assert!(counts.calls_complete && counts.tool_calls_complete);
        assert_eq!(read(&mut scanner, &path).total_tool_calls, 5);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", start("three")).unwrap();
        let next = read(&mut scanner, &path);
        assert_eq!((next.turn_calls, next.turn_tool_calls), (Some(0), Some(0)));
    }

    #[test]
    fn unidentified_or_oversized_tool_requests_report_a_lower_bound_without_polluting_model_counts()
    {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        fs::write(&path, lines(&[
            start("one"), usage(1),
            json!({"type":"response_item","payload":{"type":"function_call"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"large","arguments":"x".repeat(LINE_LIMIT+1)}}),
            json!({"type":"response_item","payload":{"type":"tool_search_call","call_id":"search"}}),
            json!({"type":"response_item","payload":{"type":"image_generation_call","id":"image-1","result":"small fixture"}}),
        ])).unwrap();
        let counts = read(&mut Scanner::default(), &path);
        assert_eq!(counts.total_calls, 1);
        assert!(counts.calls_complete);
        assert_eq!(counts.total_tool_calls, 2);
        assert!(!counts.tool_calls_complete);
    }
}
