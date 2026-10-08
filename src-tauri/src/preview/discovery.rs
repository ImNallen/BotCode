// Ported from T3 v0.0.45 apps/server/src/preview/PortScanner.ts; bounded local HTTP discovery.
use std::{
    collections::BTreeSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    process::Stdio,
    time::Duration,
};

use serde::Serialize;
use tauri::Url;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::Command,
    task::JoinSet,
};

const COMMON_PORTS: &[u16] = &[
    3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
];
const MAX_LISTENERS: usize = 64;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub port: u16,
    pub url: String,
    pub title: Option<String>,
}

pub fn loopback(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

fn parse_listeners(output: &str) -> BTreeSet<u16> {
    output
        .lines()
        .filter_map(|line| {
            let address = line.strip_prefix('n')?;
            let (host, port) = address.rsplit_once(':')?;
            let local = matches!(host, "*" | "0.0.0.0" | "[::]" | "::" | "localhost")
                || host
                    .trim_matches(['[', ']'])
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback());
            let port = port.parse::<u16>().ok()?;
            (local && port > 0).then_some(port)
        })
        .collect()
}

async fn listener_ports() -> BTreeSet<u16> {
    let query = async {
        let mut child = Command::new("/usr/sbin/lsof")
            .args(["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut stdout = child.stdout.take()?.take(131_073);
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.ok()?;
        if bytes.len() > 131_072 {
            let _ = child.kill().await;
            return None;
        }
        let status = child.wait().await.ok()?;
        if !status.success() {
            return None;
        }
        Some(parse_listeners(&String::from_utf8_lossy(&bytes)))
    };
    tokio::time::timeout(Duration::from_secs(2), query)
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

async fn connect(url: &Url) -> Option<TcpStream> {
    let port = url.port_or_known_default()?;
    let host = url.host_str()?;
    let ip = if host.eq_ignore_ascii_case("localhost") {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        let ip = host.trim_matches(['[', ']']).parse::<IpAddr>().ok()?;
        if !ip.is_loopback() {
            return None;
        }
        ip
    };
    if let Ok(stream) = TcpStream::connect((ip, port)).await {
        return Some(stream);
    }
    if url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("localhost"))
    {
        return TcpStream::connect((IpAddr::V6(Ipv6Addr::LOCALHOST), port))
            .await
            .ok();
    }
    None
}

pub async fn wait_local_ready(url: &Url) -> bool {
    if !loopback(url) {
        return true;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if tokio::time::timeout(Duration::from_millis(250), connect(url))
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn http_document(mut url: Url) -> Option<(String, Option<String>)> {
    for _ in 0..=3 {
        if url.scheme() != "http"
            || !loopback(&url)
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return None;
        }
        let mut stream = connect(&url).await?;
        let path = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_owned(),
        };
        let host = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str()?),
            None => url.host_str()?.to_owned(),
        };
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept: text/html\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut bytes = Vec::new();
        stream.take(65_536).read_to_end(&mut bytes).await.ok()?;
        let response = String::from_utf8_lossy(&bytes);
        let (headers, body) = response.split_once("\r\n\r\n")?;
        let status = headers
            .lines()
            .next()?
            .split_whitespace()
            .nth(1)?
            .parse::<u16>()
            .ok()?;
        if [301, 302, 303, 307, 308].contains(&status) {
            let location = headers.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("location").then(|| value.trim())
            })?;
            if location.len() > 8192 {
                return None;
            }
            url = url.join(location).ok()?;
            continue;
        }
        if !(200..300).contains(&status) {
            return None;
        }
        let content_type = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-type")
                .then(|| value.trim().to_ascii_lowercase())
        });
        let prefix = body
            .chars()
            .take(256)
            .collect::<String>()
            .to_ascii_lowercase();
        if !content_type.as_deref().is_some_and(|value| {
            value.contains("text/html") || value.contains("application/xhtml+xml")
        }) && !prefix.contains("<!doctype html")
            && !prefix.contains("<html")
        {
            return None;
        }
        let lower = body.to_ascii_lowercase();
        let title = lower.find("<title").and_then(|start| {
            let start = start + lower[start..].find('>')? + 1;
            let end = start + lower[start..].find("</title>")?;
            let text = body[start..end]
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (!text.is_empty()).then(|| text.chars().take(200).collect())
        });
        return Some((url.to_string(), title));
    }
    None
}

pub async fn discover() -> Vec<LocalServer> {
    let mut ports = listener_ports().await;
    ports.extend(COMMON_PORTS.iter().copied());
    let mut candidates = ports.into_iter().take(MAX_LISTENERS);
    let mut jobs = JoinSet::new();
    let mut result = Vec::new();
    loop {
        while jobs.len() < 16 {
            let Some(port) = candidates.next() else {
                break;
            };
            jobs.spawn(async move {
                let probe = async {
                    for host in ["127.0.0.1", "[::1]"] {
                        let url = Url::parse(&format!("http://{host}:{port}/")).ok()?;
                        if let Some((url, title)) = http_document(url).await {
                            return Some(LocalServer { port, url, title });
                        }
                    }
                    None
                };
                tokio::time::timeout(Duration::from_secs(1), probe)
                    .await
                    .ok()
                    .flatten()
            });
        }
        match jobs.join_next().await {
            Some(Ok(Some(server))) => result.push(server),
            Some(_) => {}
            None => break,
        }
    }
    result.sort_by_key(|server| server.port);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listener_parsing_rejects_network_hosts_and_malformed_ports() {
        let ports = parse_listeners(
            "p1\ncnode\nn127.0.0.1:43127\nn[::1]:5173\nn*:3000\nn192.168.1.5:9000\nnlocalhost:65536\nn[::]:8080\nn0.0.0.0:8000",
        );
        assert_eq!(ports, BTreeSet::from([3000, 5173, 8000, 8080, 43127]));
        assert!(!loopback(
            &Url::parse("http://127.0.0.1.evil.test:3000").unwrap()
        ));
        assert!(loopback(&Url::parse("http://[::1]:3000").unwrap()));
    }

    #[tokio::test]
    async fn probes_html_and_follows_only_local_redirects() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for response in [
                "HTTP/1.1 302 Found\r\nLocation: /page\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><title> Fixture page </title></html>",
                "HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":true}",
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                let received = stream.read(&mut buffer).await.unwrap();
                assert!(received > 0);
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        let document = http_document(url.clone()).await.unwrap();
        assert_eq!(document.0, format!("http://127.0.0.1:{port}/page"));
        assert_eq!(document.1.as_deref(), Some("Fixture page"));
        assert!(http_document(url.clone()).await.is_none());
        assert!(http_document(url).await.is_none());
        server.await.unwrap();
    }
}
