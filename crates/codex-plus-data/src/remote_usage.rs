//! Opt-in, host-scoped usage metadata over an existing SSH alias. No remote installation.
use crate::usage_activity::RemoteAccumulator;
use codex_plus_core::models::SessionRef;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::time::Duration;

const SCRIPT: &str = include_str!("remote_usage_collector.py");
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
struct Host {
    host_id: String,
    ssh_alias: String,
    profile_dir: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    version: u32,
    hosts: Vec<Host>,
}

fn valid_alias(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn valid_profile(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix(".codex") else {
        return false;
    };
    suffix.is_empty()
        || ((suffix.starts_with('-') || suffix.starts_with('_'))
            && suffix.len() <= 64
            && suffix
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)))
}

fn load_host(path: &Path, host_id: &str) -> anyhow::Result<Host> {
    let source = std::fs::read(path)?;
    anyhow::ensure!(source.len() <= 64 * 1024, "remote_usage_config_size");
    let config: Config = serde_json::from_slice(&source)
        .map_err(|_| anyhow::anyhow!("remote_usage_config_format"))?;
    anyhow::ensure!(
        config.version == 1 && config.hosts.len() <= 32,
        "remote_usage_config_version"
    );
    let mut ids = std::collections::HashSet::new();
    for host in &config.hosts {
        anyhow::ensure!(
            valid_alias(&host.ssh_alias)
                && valid_profile(&host.profile_dir)
                && !host.host_id.is_empty()
                && host.host_id.len() <= 256
                && !host.host_id.chars().any(char::is_control)
                && ids.insert(host.host_id.clone()),
            "remote_usage_config_host"
        );
    }
    config
        .hosts
        .into_iter()
        .find(|host| host.host_id == host_id)
        .ok_or_else(|| anyhow::anyhow!("remote_usage_not_configured"))
}

fn quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn collector_command() -> String {
    let inner = format!("exec python3 -u -c {}", quote_shell(SCRIPT));
    format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", quote_shell(&inner))
}

#[derive(Default)]
struct SessionState {
    reader_id: Option<String>,
    accumulator: RemoteAccumulator,
}

struct Connection {
    child: Child,
    input: ChildStdin,
    responses: mpsc::Receiver<Result<Value, ()>>,
    sequence: u64,
    sessions: HashMap<String, SessionState>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Connection {
    fn spawn(host: &Host) -> anyhow::Result<Self> {
        let mut command = Command::new(if cfg!(target_os = "macos") {
            "/usr/bin/ssh"
        } else {
            "ssh"
        });
        command.args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            "--",
            &host.ssh_alias,
            &collector_command(),
        ]);
        Self::from_command(command)
    }

    fn from_command(mut command: Command) -> anyhow::Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("remote_usage_stdin"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("remote_usage_stdout"))?;
        let (sender, responses) = mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                match output
                    .by_ref()
                    .take((MAX_RESPONSE + 1) as u64)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break,
                    Ok(_) if line.len() <= MAX_RESPONSE => {
                        // Ignore login-shell banners; only our id-correlated JSON frames are data.
                        if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                            if value.get("id").is_some() && sender.send(Ok(value)).is_err() {
                                break;
                            }
                        }
                    }
                    _ => {
                        let _ = sender.send(Err(()));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input,
            responses,
            sequence: 0,
            sessions: HashMap::new(),
        })
    }

    fn request(&mut self, host: &Host, session_id: &str) -> anyhow::Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        let reader_id = self
            .sessions
            .get(session_id)
            .and_then(|state| state.reader_id.clone());
        let request = json!({"id":id,"session_id":session_id,"profile_dir":host.profile_dir,"reader_id":reader_id});
        writeln!(self.input, "{request}")?;
        self.input.flush()?;
        let response = self
            .responses
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| anyhow::anyhow!("remote_usage_timeout"))?
            .map_err(|_| anyhow::anyhow!("remote_usage_frame"))?;
        anyhow::ensure!(
            response["id"].as_u64() == Some(id),
            "remote_usage_response_id"
        );
        let status = response["status"].as_str().unwrap_or("failed");
        if status != "ok" {
            return Ok(
                json!({"status":status,"session_id":session_id,"host_id":host.host_id,"events":[],"message":status_message(status)}),
            );
        }
        anyhow::ensure!(
            response["session_id"] == session_id && response["profile_dir"] == host.profile_dir,
            "remote_usage_scope"
        );
        let token = response["reader_id"]
            .as_str()
            .filter(|token| token.len() <= 128)
            .ok_or_else(|| anyhow::anyhow!("remote_usage_reader"))?;
        let records = response["records"]
            .as_array()
            .filter(|records| records.len() <= 512)
            .ok_or_else(|| anyhow::anyhow!("remote_usage_records"))?;
        let complete = response["complete"]
            .as_bool()
            .ok_or_else(|| anyhow::anyhow!("remote_usage_complete"))?;
        let reset = response["reset"]
            .as_bool()
            .ok_or_else(|| anyhow::anyhow!("remote_usage_reset"))?;
        if !self.sessions.contains_key(session_id) && self.sessions.len() >= 32 {
            // Reader tokens ensure the remote side rescans if a local accumulator was evicted.
            if let Some(key) = self.sessions.keys().next().cloned() {
                self.sessions.remove(&key);
            }
        }
        let state = self.sessions.entry(session_id.to_owned()).or_default();
        let reset = reset || state.reader_id.as_deref() != Some(token);
        state.reader_id = Some(token.to_owned());
        let mut result = state.accumulator.ingest(records, reset, complete);
        result["status"] = json!("ok");
        result["session_id"] = json!(session_id);
        result["host_id"] = json!(host.host_id);
        result["source"] = json!("ssh");
        Ok(result)
    }
}

fn status_message(status: &str) -> &'static str {
    match status {
        "profile_mismatch" => "远端 Codex profile 与连接配置不一致",
        "not_found" => "远端尚未找到此会话记录",
        "invalid_session" => "远端会话 ID 无效",
        _ => "远端用量采集暂不可用",
    }
}

type Slot = Arc<Mutex<Option<Connection>>>;
static CONNECTIONS: OnceLock<Mutex<VecDeque<(Host, Slot)>>> = OnceLock::new();

pub fn read_remote_usage(session: &SessionRef) -> Value {
    read_from_config(
        &codex_plus_core::paths::shared_config_dir().join("remote-usage-hosts.json"),
        session,
    )
}

fn read_from_config(path: &Path, session: &SessionRef) -> Value {
    let host_id = session.host_id.as_deref().unwrap_or_default();
    let session_id = session
        .session_id
        .strip_prefix("local:")
        .unwrap_or(&session.session_id);
    let result = (|| -> anyhow::Result<Value> {
        anyhow::ensure!(
            uuid::Uuid::parse_str(session_id).is_ok(),
            "remote_usage_invalid_session"
        );
        let host = load_host(path, host_id)?;
        let slot = {
            let mut connections = CONNECTIONS
                .get_or_init(Mutex::default)
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let slot = connections
                .iter()
                .position(|(key, _)| key == &host)
                .and_then(|index| connections.remove(index))
                .map(|(_, slot)| slot)
                .unwrap_or_default();
            connections.push_back((host.clone(), Arc::clone(&slot)));
            while connections.len() > 8 {
                connections.pop_front();
            }
            slot
        };
        let mut connection = slot.lock().unwrap_or_else(|e| e.into_inner());
        if connection.is_none() {
            *connection = Some(Connection::spawn(&host)?);
        }
        let result = connection.as_mut().unwrap().request(&host, session_id);
        if result.is_err() {
            *connection = None;
        }
        result
    })();
    result.unwrap_or_else(|_| json!({"status":"unavailable","session_id":session_id,"host_id":host_id,"events":[],"message":"远端统计未配置或 SSH 采集不可用"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    const SESSION: &str = "11111111-1111-4111-8111-111111111111";

    fn host(profile: &str) -> Host {
        Host {
            host_id: format!("remote-ssh-discovered:{profile}"),
            ssh_alias: "dev".into(),
            profile_dir: profile.into(),
        }
    }

    fn fixture(root: &Path, profile: &str, calls: u64) -> PathBuf {
        let home = root.join(profile);
        fs::create_dir_all(home.join("sessions")).unwrap();
        let path = home
            .join("sessions")
            .join(format!("rollout-{SESSION}.jsonl"));
        let mut records =
            vec![json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}})];
        for i in 1..=calls {
            records.push(json!({"type":"event_msg","timestamp":"2026-10-26T00:00:00Z","payload":{"type":"token_count","info":{
                "last_token_usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11},
                "total_token_usage":{"input_tokens":i*10,"output_tokens":i,"total_tokens":i*11},"model_context_window":100000
            }}}));
            records.push(json!({"type":"response_item","payload":{"type":"function_call","call_id":format!("call-{i}"),"arguments":"DO_NOT_TRANSFER_THIS_BODY"}}));
        }
        fs::write(
            &path,
            records
                .iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
        db.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO threads VALUES (?1,?2)",
            rusqlite::params![SESSION, path.to_string_lossy()],
        )
        .unwrap();
        home
    }

    fn connection(root: &Path, profile: &str) -> Connection {
        let wrapper = format!(
            "import json,sys\nns={{'__name__':'collector_test'}}\nexec({},ns)\ncollector=ns['Collector'](sys.argv[1],sys.argv[2])\nfor line in sys.stdin:\n r=json.loads(line)\n v=collector.request(r)\n v['id']=r['id']\n print(json.dumps(v),flush=True)\n",
            serde_json::to_string(SCRIPT).unwrap()
        );
        let mut command = Command::new("python3");
        command
            .args(["-u", "-c", &wrapper])
            .arg(root)
            .arg(root.join(profile));
        Connection::from_command(command).unwrap()
    }

    #[test]
    fn config_is_opt_in_and_rejects_alias_injection_and_ambiguous_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.json");
        fs::write(&path, r#"{"version":1,"hosts":[{"host_id":"remote:dev","ssh_alias":"dev; touch /tmp/x","profile_dir":".codex"}]}"#).unwrap();
        assert!(load_host(&path, "remote:dev").is_err());
        assert!(!valid_alias("-oProxyCommand=bad"));
        assert!(!valid_profile(".codex/../../other"));
        fs::write(&path, r#"{"version":1,"hosts":[]}"#).unwrap();
        let session = SessionRef {
            session_id: SESSION.into(),
            title: String::new(),
            host_id: Some("remote:dev".into()),
        };
        assert_eq!(read_from_config(&path, &session)["status"], "unavailable");
        let good = r#"{"host_id":"remote:dev","ssh_alias":"dev-kth","profile_dir":".codex-kth"}"#;
        fs::write(&path, format!(r#"{{"version":1,"hosts":[{good},{good}]}}"#)).unwrap();
        assert!(load_host(&path, "remote:dev").is_err());
    }

    #[test]
    fn collector_projects_metadata_without_prompt_tool_arguments_or_outputs() {
        let code=format!("import json\nns={{'__name__':'collector_test'}}\nexec({},ns)\nprint(json.dumps([ns['project'](x.encode()) for x in {}]))",serde_json::to_string(SCRIPT).unwrap(),serde_json::to_string(&[
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"a","arguments":"SECRET_BODY"}}).to_string(),
            json!({"type":"response_item","payload":{"type":"message","content":"SECRET_PROMPT"}}).to_string(),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"a","output":"SECRET_OUTPUT"}}).to_string(),
        ]).unwrap());
        let output = Command::new("python3")
            .args(["-c", &code])
            .output()
            .unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(!text.contains("SECRET"));
        let rows: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(rows[0]["payload"]["call_id"], "a");
        assert!(rows[1].is_null() && rows[2].is_null());
    }

    #[test]
    fn same_session_id_is_isolated_by_profile_and_cache_eviction_forces_replay() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path(), ".codex", 2);
        fixture(dir.path(), ".codex-kth", 1);
        let mut official = connection(dir.path(), ".codex");
        let mut kth = connection(dir.path(), ".codex-kth");
        let a = official.request(&host(".codex"), SESSION).unwrap();
        let b = kth.request(&host(".codex-kth"), SESSION).unwrap();
        assert_eq!(a["activity"]["total_calls"], 2);
        assert_eq!(b["activity"]["total_calls"], 1);
        assert_eq!(a["activity"]["total_tool_calls"], 2);
        assert_eq!(a["activity"]["cumulative_tokens"], 22);
        assert_eq!(
            official.request(&host(".codex"), SESSION).unwrap()["activity"]["total_calls"],
            2
        );
        official.sessions.clear();
        assert_eq!(
            official.request(&host(".codex"), SESSION).unwrap()["activity"]["total_calls"],
            2,
            "eviction must replay, not display zero"
        );
        assert_eq!(
            official.request(&host(".codex-kth"), SESSION).unwrap()["status"],
            "profile_mismatch"
        );
    }

    #[test]
    fn collector_incremental_bounds_and_path_isolation() {
        let code = format!(
            "exec({}, globals())\nexec({}, globals())",
            serde_json::to_string(&SCRIPT.replace("if __name__ == \"__main__\":", "if False:"))
                .unwrap(),
            serde_json::to_string(include_str!("remote_usage_collector_test.py")).unwrap()
        );
        let output = Command::new("python3")
            .args(["-c", &code])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn transport_rejects_uncorrelated_frames() {
        let mut command = Command::new("python3");
        command.args(["-u","-c","import sys,json; r=json.loads(sys.stdin.readline()); print(json.dumps({'id':r['id']+1,'status':'ok'}),flush=True)"]);
        let mut connection = Connection::from_command(command).unwrap();
        assert!(connection.request(&host(".codex"), SESSION).is_err());
    }
}
