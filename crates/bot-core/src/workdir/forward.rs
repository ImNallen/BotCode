//! A sandbox's local servers, reached from the Mac. Docker cannot publish a server bound to the
//! container's loopback, so one in-image gateway relays to `localhost:<port>` and Docker
//! publishes the gateway alone. For each container port the Preview needs, a Mac listener on
//! `127.0.0.1` opens a gateway connection per client connection and pipes it. A listener keeps
//! its Mac port until the container stops, and every connection through it counts as use.
use super::{Phase, SandboxHandle};
use crate::{domain::*, sandbox::Probe};
use std::{
    collections::{BTreeSet, HashMap},
    net::Ipv4Addr,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tokio::{net::TcpStream, task::JoinSet};

#[derive(Default)]
pub(crate) struct Forwards {
    /// The Mac port of the gateway, once started in the container's current run.
    gateway: tokio::sync::Mutex<Option<u16>>,
    /// Container port to the Mac listener that forwards to it.
    listeners: Mutex<HashMap<u16, Listener>>,
    /// What the last probe found listening. A paused container still reports it.
    servers: Mutex<BTreeSet<u16>>,
}
struct Listener {
    port: u16,
    task: tokio::task::AbortHandle,
}
impl Drop for Listener {
    /// Ends the accept loop, whose set of connections then aborts every open one.
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Where a thread's local servers run, which its Preview and links reach.
#[derive(Clone)]
pub enum LocalNetwork {
    Mac,
    Sandbox(SandboxNetwork),
}
/// The local servers inside one sandbox container.
#[derive(Clone)]
pub struct SandboxNetwork(pub(crate) Arc<SandboxHandle>);
/// The container's TCP listeners that `localhost` reaches, without Bot Code's own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listeners {
    pub ports: BTreeSet<u16>,
    /// Read just now from a running container. Otherwise this is what the last reading saw,
    /// and connecting would wake the container.
    pub live: bool,
}
impl SandboxNetwork {
    /// Probes a running container. A paused one reports its last reading, and a stopped one
    /// nothing, because its servers stopped with it. Neither wakes the container.
    pub async fn listeners(&self) -> Result<Listeners> {
        let handle = &self.0;
        let live = handle.phase() == Phase::Running;
        if live {
            let probe = handle.container.probe().await?;
            handle.observe_network(&probe).await;
        }
        Ok(Listeners {
            ports: handle.forwards.servers.lock().unwrap().clone(),
            live,
        })
    }
    /// A connection to `localhost:<port>` in a running container that neither wakes it nor
    /// counts as use, for discovery.
    pub async fn dial(&self, port: u16) -> Result<TcpStream> {
        self.0.dial(port).await
    }
    /// The Mac loopback port that forwards to `port` in the container.
    pub fn forward(&self, port: u16) -> Result<u16> {
        self.0.forward(port)
    }
}

impl SandboxHandle {
    async fn dial(&self, port: u16) -> Result<TcpStream> {
        let gateway = {
            let mut gateway = self.forwards.gateway.lock().await;
            match *gateway {
                Some(gateway) => gateway,
                None => {
                    let started = self.container.start_gateway(&self.gateway_secret).await?;
                    *gateway = Some(started);
                    started
                }
            }
        };
        Ok(crate::sandbox::dial(gateway, &self.gateway_secret, port).await?)
    }
    /// Binds the listener for `port` on first use and returns its Mac port.
    pub(crate) fn forward(self: &Arc<Self>, port: u16) -> Result<u16> {
        let mut listeners = self.forwards.listeners.lock().unwrap();
        if let Some(listener) = listeners.get(&port) {
            return Ok(listener.port);
        }
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let mac = listener.local_addr()?.port();
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let task = tokio::spawn(accept(Arc::downgrade(self), port, listener));
        listeners.insert(
            port,
            Listener {
                port: mac,
                task: task.abort_handle(),
            },
        );
        Ok(mac)
    }
    /// One client connection: counted as use while open, the container woken, then piped to
    /// the gateway until either side closes.
    async fn relay(&self, port: u16, mut client: TcpStream) {
        let _open = Open::new(self);
        if let Err(error) = self.wake().await {
            self.log(&format!("forward to {port}: {}", error.message));
            return;
        }
        let mut upstream = match self.dial(port).await {
            Ok(upstream) => upstream,
            Err(error) => {
                self.log(&format!("forward to {port}: {}", error.message));
                return;
            }
        };
        let _ = client.set_nodelay(true);
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    }
    /// The Mac ports of this sandbox's listeners.
    pub(crate) fn forwarder_ports(&self) -> Vec<u16> {
        let listeners = self.forwards.listeners.lock().unwrap();
        listeners.values().map(|listener| listener.port).collect()
    }
    /// Folds a probe's network facts in: what listens, and whether the gateway still runs.
    pub(super) async fn observe_network(&self, probe: &Probe) {
        *self.forwards.servers.lock().unwrap() = probe.listeners.clone();
        if !probe.gateway_running {
            *self.forwards.gateway.lock().await = None;
        }
    }
    /// Closes every listener and its connections. The container stopped, so its servers
    /// stopped with it, and its next start publishes the gateway on a new port.
    pub(super) async fn close_forwards(&self) {
        self.forwards.listeners.lock().unwrap().clear();
        self.forwards.servers.lock().unwrap().clear();
        *self.forwards.gateway.lock().await = None;
    }
}

struct Open<'a>(&'a SandboxHandle);
impl<'a> Open<'a> {
    fn new(handle: &'a SandboxHandle) -> Self {
        handle.activity.lock().unwrap().open_forward(Instant::now());
        Self(handle)
    }
}
impl Drop for Open<'_> {
    fn drop(&mut self) {
        self.0
            .activity
            .lock()
            .unwrap()
            .close_forward(Instant::now());
    }
}

async fn accept(handle: Weak<SandboxHandle>, port: u16, listener: tokio::net::TcpListener) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((client, _)) = accepted else {
                    // Out of descriptors, most likely; retrying at once would spin.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                };
                let Some(handle) = handle.upgrade() else { return };
                connections.spawn(async move { handle.relay(port, client).await });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}
