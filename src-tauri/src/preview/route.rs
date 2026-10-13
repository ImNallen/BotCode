use bot_core::{App, LocalNetwork};
use tauri::{AppHandle, Manager, Url};

use super::{discovery::loopback, model::PreviewScope};

fn container_port(url: &Url) -> Option<u16> {
    loopback(url).then(|| url.port_or_known_default()).flatten()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alias {
    pub container_port: u16,
    forwarded: Url,
    shown: Url,
}
impl Alias {
    pub fn shown(&self, url: &str) -> String {
        match Url::parse(url) {
            Ok(url) if url.origin() == self.forwarded.origin() => {
                rebase(&url, &self.shown).to_string()
            }
            _ => url.to_owned(),
        }
    }
}

pub fn load(network: &LocalNetwork, url: &Url) -> Result<(Url, Option<Alias>), String> {
    let LocalNetwork::Sandbox(sandbox) = network else {
        return Ok((url.clone(), None));
    };
    let Some(port) = container_port(url) else {
        return Ok((url.clone(), None));
    };
    let mac = sandbox.forward(port).map_err(|error| error.message)?;
    let forwarded = forwarded(url, mac);
    let alias = Alias {
        container_port: port,
        shown: url.clone(),
        forwarded: forwarded.clone(),
    };
    Ok((forwarded, Some(alias)))
}

fn forwarded(url: &Url, mac_port: u16) -> Url {
    let mut forwarded = url.clone();
    let _ = forwarded.set_host(Some("127.0.0.1"));
    let _ = forwarded.set_port(Some(mac_port));
    forwarded
}

fn rebase(url: &Url, origin: &Url) -> Url {
    let mut rebased = url.clone();
    let _ = rebased.set_scheme(origin.scheme());
    let _ = rebased.set_host(origin.host_str());
    let _ = rebased.set_port(origin.port());
    rebased
}

pub async fn network(app: &AppHandle, scope: &PreviewScope) -> Result<LocalNetwork, String> {
    let PreviewScope::Thread { thread_id } = scope else {
        return Ok(LocalNetwork::Mac);
    };
    let Some(runtime) = app.try_state::<App>() else {
        return Ok(LocalNetwork::Mac);
    };
    runtime
        .local_network(thread_id.clone())
        .await
        .map_err(|error| error.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn a_sandbox_thread_maps_loopback_urls_and_nothing_else() {
        for (raw, port) in [
            ("http://localhost:5173/", 5173),
            ("http://LOCALHOST:5173/src/App.tsx?t=1#top", 5173),
            ("http://127.0.0.1:3000/", 3000),
            ("http://[::1]:8080/api", 8080),
            ("http://localhost/", 80),
            ("https://localhost/", 443),
        ] {
            assert_eq!(container_port(&url(raw)), Some(port), "{raw}");
        }
        for raw in [
            "https://example.com/",
            "http://127.0.0.1.example.com:3000/",
            "http://192.168.1.5:5173/",
            "http://[::2]:5173/",
        ] {
            assert_eq!(container_port(&url(raw)), None, "{raw}");
        }
    }

    #[test]
    fn a_forwarded_page_shows_the_container_address_it_was_opened_with() {
        for (opened, shown) in [
            (
                "http://localhost:5173/",
                "http://localhost:5173/about?tab=1#team",
            ),
            ("http://[::1]:5173/", "http://[::1]:5173/about?tab=1#team"),
            (
                "http://127.0.0.1:5173/",
                "http://127.0.0.1:5173/about?tab=1#team",
            ),
        ] {
            let opened = url(opened);
            let loaded = forwarded(&opened, 49152);
            assert_eq!(loaded.as_str(), "http://127.0.0.1:49152/");
            let alias = Alias {
                container_port: 5173,
                forwarded: loaded,
                shown: opened,
            };
            assert_eq!(
                alias.shown("http://127.0.0.1:49152/about?tab=1#team"),
                shown
            );
            for elsewhere in [
                "http://127.0.0.1:49153/about",
                "https://example.com/",
                "about:blank",
            ] {
                assert_eq!(alias.shown(elsewhere), elsewhere);
            }
        }
        let path = forwarded(&url("http://[::1]:5173/a/b?c=d#e"), 50000);
        assert_eq!(path.as_str(), "http://127.0.0.1:50000/a/b?c=d#e");
    }

    #[test]
    fn a_mac_thread_loads_every_url_as_it_is() {
        for raw in ["http://localhost:5173/", "https://example.com/"] {
            assert_eq!(
                load(&LocalNetwork::Mac, &url(raw)).unwrap(),
                (url(raw), None)
            );
        }
    }
}
