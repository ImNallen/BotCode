// Ported from pingdotgg/t3code v0.0.45 apps/server/src/provider/Layers/CodexProvider.ts (MIT).
use crate::{codex::Codex, domain::Result, log::RotatingLog};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::sync::mpsc;

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub path: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
}

#[derive(Deserialize)]
struct SkillsListResponse {
    data: Vec<SkillsListEntry>,
}

#[derive(Deserialize)]
struct SkillsListEntry {
    cwd: String,
    skills: Vec<SkillMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillMetadata {
    name: String,
    path: String,
    enabled: bool,
    scope: Option<String>,
    description: Option<String>,
    short_description: Option<String>,
    interface: Option<SkillInterface>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillInterface {
    display_name: Option<String>,
    short_description: Option<String>,
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn parse(response: Value, cwd: &Path) -> Result<Vec<Skill>> {
    let mut response: SkillsListResponse = serde_json::from_value(response)?;
    let skills = match response
        .data
        .iter()
        .position(|entry| entry.cwd == cwd.to_string_lossy())
    {
        Some(index) => response.data.swap_remove(index).skills,
        None => response
            .data
            .into_iter()
            .flat_map(|entry| entry.skills)
            .collect(),
    };
    Ok(skills
        .into_iter()
        .map(|skill| {
            let interface = skill.interface;
            let short_description = skill.short_description.or_else(|| {
                interface
                    .as_ref()
                    .and_then(|interface| interface.short_description.clone())
            });
            Skill {
                name: skill.name,
                path: skill.path,
                enabled: skill.enabled,
                scope: nonempty(skill.scope),
                description: nonempty(skill.description),
                display_name: nonempty(interface.and_then(|interface| interface.display_name)),
                short_description: nonempty(short_description),
            }
        })
        .collect())
}

pub(crate) async fn list(binary: &Path, cwd: &Path, log: RotatingLog) -> Vec<Skill> {
    list_with_timeout(binary, cwd, DISCOVERY_TIMEOUT, log).await
}

async fn list_with_timeout(
    binary: &Path,
    cwd: &Path,
    timeout: Duration,
    log: RotatingLog,
) -> Vec<Skill> {
    let (events, mut signals) = mpsc::channel(16);
    let provider = match Codex::launch(binary.to_owned(), 0, events, log).await {
        Ok(provider) => provider,
        Err(_) => return vec![],
    };
    let drain = tokio::spawn(async move { while signals.recv().await.is_some() {} });
    let result = tokio::time::timeout(timeout, async {
        provider.initialize().await?;
        let response = provider
            .request("skills/list", json!({"cwds": [cwd], "forceReload": true}))
            .await?;
        parse(response, cwd)
    })
    .await;
    let _ = provider.terminate().await;
    drain.abort();
    result
        .ok()
        .and_then(std::result::Result::ok)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(name: &str) -> Value {
        json!({
            "name": name,
            "path": format!("/skills/{name}/SKILL.md"),
            "enabled": true,
            "scope": "user",
            "description": "Full description",
            "interface": { "displayName": "Display name", "shortDescription": "Interface summary" }
        })
    }

    #[test]
    fn matching_checkout_keeps_only_its_skills_and_metadata() {
        let response = json!({"data": [
            {"cwd": "/other", "skills": [metadata("other")]},
            {"cwd": "/checkout", "skills": [metadata("poteto-mode")]}
        ]});
        assert_eq!(
            parse(response, Path::new("/checkout")).unwrap(),
            vec![Skill {
                name: "poteto-mode".into(),
                path: "/skills/poteto-mode/SKILL.md".into(),
                enabled: true,
                scope: Some("user".into()),
                description: Some("Full description".into()),
                display_name: Some("Display name".into()),
                short_description: Some("Interface summary".into()),
            }]
        );
    }

    #[test]
    fn unmatched_checkout_flattens_entries_in_response_order() {
        let response = json!({"data": [
            {"cwd": "/a", "skills": [metadata("first")]},
            {"cwd": "/b", "skills": [metadata("second")]}
        ]});
        let names: Vec<_> = parse(response, Path::new("/checkout"))
            .unwrap()
            .into_iter()
            .map(|skill| skill.name)
            .collect();
        assert_eq!(names, ["first", "second"]);
    }

    #[test]
    fn legacy_summary_precedes_interface_summary_and_disabled_is_preserved() {
        let mut skill = metadata("disabled");
        skill["enabled"] = json!(false);
        skill["shortDescription"] = json!("Legacy summary");
        let skills = parse(
            json!({"data": [{"cwd": "/checkout", "skills": [skill]}]}),
            Path::new("/checkout"),
        )
        .unwrap();
        assert!(!skills[0].enabled);
        assert_eq!(
            skills[0].short_description.as_deref(),
            Some("Legacy summary")
        );
        assert_eq!(
            serde_json::to_value(&skills[0]).unwrap()["displayName"],
            "Display name"
        );
    }

    #[test]
    fn empty_legacy_summary_does_not_fall_back_and_empty_metadata_is_omitted() {
        let mut skill = metadata("minimal");
        skill["shortDescription"] = json!("");
        skill["description"] = json!("");
        skill["scope"] = json!("");
        skill["interface"]["displayName"] = json!("");
        let skills = parse(
            json!({"data": [{"cwd": "/checkout", "skills": [skill]}]}),
            Path::new("/checkout"),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&skills[0]).unwrap(),
            json!({"name": "minimal", "path": "/skills/minimal/SKILL.md", "enabled": true})
        );
    }

    #[test]
    fn malformed_protocol_fails_at_the_boundary() {
        for response in [
            json!({}),
            json!({"data": {}}),
            json!({"data": [{"cwd": "/checkout", "skills": [{"name": "incomplete"}]}]}),
        ] {
            assert!(parse(response, Path::new("/checkout")).is_err());
        }
    }

    #[test]
    fn valid_empty_response_has_no_skills() {
        assert!(
            parse(json!({"data": []}), Path::new("/checkout"))
                .unwrap()
                .is_empty()
        );
    }

    #[cfg(unix)]
    mod process {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        struct Peer {
            dir: tempfile::TempDir,
            binary: std::path::PathBuf,
        }

        impl Peer {
            fn new(mode: &str) -> Self {
                let dir = tempfile::tempdir().unwrap();
                let binary = dir.path().join("codex.py");
                std::fs::write(&binary, PEER).unwrap();
                std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
                std::fs::write(dir.path().join("mode"), mode).unwrap();
                Self { dir, binary }
            }

            fn log(&self) -> RotatingLog {
                RotatingLog::open(self.dir.path().join("codex.log"))
            }

            fn calls(&self) -> Vec<Value> {
                std::fs::read_to_string(self.dir.path().join("calls.jsonl"))
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect()
            }

            fn assert_stopped(&self) {
                let pid: i32 = std::fs::read_to_string(self.dir.path().join("pid"))
                    .unwrap()
                    .parse()
                    .unwrap();
                assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            }
        }

        const PEER: &str = r#"#!/usr/bin/env python3
import json, os, pathlib, sys, time
root = pathlib.Path(__file__).parent
mode = (root / 'mode').read_text()
(root / 'pid').write_text(str(os.getpid()))
for line in sys.stdin:
    frame = json.loads(line)
    with (root / 'calls.jsonl').open('a') as log:
        log.write(json.dumps(frame) + '\n')
    method = frame.get('method')
    if method == 'initialize':
        if mode == 'stall':
            time.sleep(30)
        result = {}
    elif method == 'initialized':
        continue
    elif method == 'skills/list':
        if mode == 'unsupported':
            print(json.dumps({'id': frame['id'], 'error': {'code': -32601, 'message': 'Unknown method'}}), flush=True)
            continue
        if mode == 'lost':
            sys.exit(1)
        if mode == 'malformed':
            result = {'data': [{'cwd': frame['params']['cwds'][0], 'skills': [{'name': 'incomplete'}]}]}
        else:
            result = {'data': [{'cwd': frame['params']['cwds'][0], 'skills': [{'name': 'repo-skill', 'path': '/checkout/.agents/skills/repo-skill/SKILL.md', 'scope': 'repo', 'enabled': True}]}]}
    else:
        sys.exit(2)
    print(json.dumps({'id': frame['id'], 'result': result}), flush=True)
"#;

        #[tokio::test]
        async fn discovery_initializes_requests_checkout_and_terminates() {
            let peer = Peer::new("success");
            let skills = list(&peer.binary, Path::new("/checkout"), peer.log()).await;
            assert_eq!(skills.len(), 1);
            assert_eq!(skills[0].name, "repo-skill");
            assert_eq!(skills[0].scope.as_deref(), Some("repo"));
            let calls = peer.calls();
            assert_eq!(calls.len(), 3);
            assert_eq!(calls[0]["method"], "initialize");
            assert_eq!(calls[1]["method"], "initialized");
            assert_eq!(calls[2]["method"], "skills/list");
            assert_eq!(
                calls[2]["params"],
                json!({"cwds": ["/checkout"], "forceReload": true})
            );
            peer.assert_stopped();
        }

        #[tokio::test]
        async fn unsupported_malformed_and_lost_provider_return_empty_and_terminate() {
            for mode in ["unsupported", "malformed", "lost"] {
                let peer = Peer::new(mode);
                assert!(
                    list(&peer.binary, Path::new("/checkout"), peer.log())
                        .await
                        .is_empty(),
                    "{mode}"
                );
                peer.assert_stopped();
            }
        }

        #[tokio::test]
        async fn discovery_timeout_returns_empty_and_terminates() {
            let peer = Peer::new("stall");
            assert!(
                list_with_timeout(
                    &peer.binary,
                    Path::new("/checkout"),
                    Duration::from_millis(250),
                    peer.log()
                )
                .await
                .is_empty()
            );
            peer.assert_stopped();
        }

        #[tokio::test]
        async fn missing_binary_returns_empty() {
            let dir = tempfile::tempdir().unwrap();
            assert!(
                list(
                    &dir.path().join("missing-codex"),
                    dir.path(),
                    RotatingLog::open(dir.path().join("codex.log"))
                )
                .await
                .is_empty()
            );
        }

        #[tokio::test]
        async fn app_uses_configured_binary_and_refreshes_each_checkout() {
            let peer = Peer::new("success");
            let app = crate::App::open(crate::RuntimeConfig {
                data_dir: peer.dir.path().join("state"),
                codex_binary: peer.binary.clone(),
                gh_binary: peer.dir.path().join("missing-gh"),
                network_timeout: Duration::from_secs(180),
                shell: None,
            })
            .await
            .unwrap();
            for cwd in ["/first-checkout", "/second-checkout"] {
                let skills = app.list_skills(cwd.into()).await;
                assert_eq!(skills.len(), 1);
                assert_eq!(peer.calls().last().unwrap()["params"]["cwds"], json!([cwd]));
                peer.assert_stopped();
            }
            assert_eq!(peer.calls().len(), 6);
            app.shutdown().await.unwrap();
        }
    }
}
