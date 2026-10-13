use super::{
    Prepare,
    collaboration::{self, ModePreset, ProviderSession},
    restarts::Restarts,
};
use crate::{
    codex::{
        AgentProcess, Codex, Signal,
        auth::{Credentials, TokenBroker},
    },
    diagnostics::ProviderPids,
    domain::*,
    log::RotatingLog,
    sandbox::{Attach, Exec, WORKSPACE},
    workdir::SandboxHandle,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

const AGENT: &str = "/opt/botcode/bin/agent";

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum EnvKey {
    Mac,
    Sandbox(SandboxId),
}
impl EnvKey {
    pub(super) fn of(checkout: &Checkout) -> Self {
        match checkout.sandbox() {
            None => Self::Mac,
            Some(Sandbox::Docker { id }) => Self::Sandbox(id.clone()),
        }
    }
}

#[derive(Default)]
enum SlotState {
    #[default]
    Idle,
    Launching {
        epoch: u64,
    },
    Live {
        epoch: u64,
        codex: Codex,
        modes: Vec<ModePreset>,
        account: Option<String>,
    },
}
impl SlotState {
    fn epoch(&self) -> Option<u64> {
        match self {
            Self::Idle => None,
            Self::Launching { epoch } | Self::Live { epoch, .. } => Some(*epoch),
        }
    }
}
#[derive(Default)]
struct Slot {
    state: SlotState,
    restarts: Restarts,
    pending: Vec<Prepare>,
}

#[derive(Default)]
pub(super) struct Providers {
    next_epoch: u64,
    slots: HashMap<EnvKey, Slot>,
}
pub(super) struct Launch {
    pub epoch: u64,
    pub delay: Duration,
    pub failures: u32,
}
impl Providers {
    pub(super) fn client(&self, key: &EnvKey) -> Option<(u64, Codex)> {
        match &self.slots.get(key)?.state {
            SlotState::Live { epoch, codex, .. } => Some((*epoch, codex.clone())),
            _ => None,
        }
    }
    pub(super) fn key(&self, epoch: u64) -> Option<&EnvKey> {
        self.slots
            .iter()
            .find(|(_, slot)| slot.state.epoch() == Some(epoch))
            .map(|(key, _)| key)
    }
    pub(super) fn current(&self, epoch: u64) -> bool {
        self.key(epoch).is_some()
    }
    pub(super) fn live(&self, epoch: u64) -> Option<(&EnvKey, &Codex)> {
        self.slots.iter().find_map(|(key, slot)| match &slot.state {
            SlotState::Live {
                epoch: live, codex, ..
            } if *live == epoch => Some((key, codex)),
            _ => None,
        })
    }
    pub(super) fn modes(&self, key: &EnvKey) -> &[ModePreset] {
        match self.slots.get(key).map(|slot| &slot.state) {
            Some(SlotState::Live { modes, .. }) => modes,
            _ => &[],
        }
    }
    pub(super) fn account(&self, key: &EnvKey) -> Option<&str> {
        match self.slots.get(key).map(|slot| &slot.state) {
            Some(SlotState::Live { account, .. }) => account.as_deref(),
            _ => None,
        }
    }
    pub(super) fn begin_launch(&mut self, key: &EnvKey, now: Instant) -> Option<Launch> {
        let slot = self.slots.entry(key.clone()).or_default();
        if !matches!(slot.state, SlotState::Idle) {
            return None;
        }
        self.next_epoch += 1;
        slot.state = SlotState::Launching {
            epoch: self.next_epoch,
        };
        Some(Launch {
            epoch: self.next_epoch,
            delay: slot.restarts.delay(now),
            failures: slot.restarts.failures(),
        })
    }
    pub(super) fn launched(
        &mut self,
        key: &EnvKey,
        codex: Codex,
        modes: Vec<ModePreset>,
        account: Option<String>,
        now: Instant,
    ) -> Vec<Prepare> {
        let slot = self.slots.get_mut(key).unwrap();
        let SlotState::Launching { epoch } = slot.state else {
            unreachable!("only a launching slot completes a launch");
        };
        slot.state = SlotState::Live {
            epoch,
            codex,
            modes,
            account,
        };
        slot.restarts.ready(now);
        std::mem::take(&mut slot.pending)
    }
    pub(super) fn queue(&mut self, key: EnvKey, job: Prepare) {
        self.slots.entry(key).or_default().pending.push(job);
    }
    pub(super) fn pending(&self) -> impl Iterator<Item = &Prepare> {
        self.slots.values().flat_map(|slot| &slot.pending)
    }
    pub(super) fn notice(&self, key: &EnvKey, now: Instant) -> Option<String> {
        self.slots.get(key)?.restarts.notice(now)
    }
    pub(super) fn keys(&self) -> Vec<EnvKey> {
        self.slots.keys().cloned().collect()
    }
    pub(super) fn active(&self, key: &EnvKey) -> bool {
        self.slots
            .get(key)
            .is_some_and(|slot| slot.state.epoch().is_some())
    }
    pub(super) fn lose(&mut self, key: &EnvKey, now: Instant, closing: bool) -> Option<Codex> {
        let slot = self.slots.get_mut(key)?;
        slot.pending.clear();
        let state = std::mem::take(&mut slot.state);
        if state.epoch().is_some() && !closing {
            slot.restarts.lost(now);
        }
        match state {
            SlotState::Live { codex, .. } => Some(codex),
            _ => None,
        }
    }
    /// Retires the slot's epoch, so a launch still in flight completes as stale and its
    /// process is terminated on arrival. Returns the live agent for the caller to terminate.
    pub(super) fn stop(&mut self, key: &EnvKey) -> Option<Codex> {
        let slot = self.slots.get_mut(key)?;
        match std::mem::take(&mut slot.state) {
            SlotState::Live { codex, .. } => Some(codex),
            SlotState::Idle | SlotState::Launching { .. } => None,
        }
    }
}

pub(super) enum Launcher {
    Mac {
        binary: PathBuf,
    },
    Sandbox {
        handle: Arc<SandboxHandle>,
        broker: TokenBroker,
    },
}
impl Launcher {
    pub(super) async fn start(
        self,
        epoch: u64,
        events: mpsc::Sender<Signal>,
        log: RotatingLog,
        pids: ProviderPids,
    ) -> Result<ProviderSession> {
        let (process, credentials) = match self {
            Self::Mac { binary } => (AgentProcess::mac(&binary), None),
            Self::Sandbox { handle, broker } => {
                let credentials = broker.read()?;
                handle.ready().await?;
                let command = handle.container.command(
                    &Exec {
                        argv: &[AGENT],
                        workdir: WORKSPACE,
                        env: &[],
                    },
                    Attach::Stdin,
                );
                (AgentProcess::new(command), Some(credentials))
            }
        };
        let provider = Codex::launch(process, epoch, events, log, pids).await?;
        let prepared = async {
            provider.initialize().await?;
            match &credentials {
                Some(credentials) => crate::codex::auth::login(&provider, credentials).await,
                None => Ok(()),
            }
        }
        .await;
        if let Err(error) = prepared {
            let _ = provider.terminate().await;
            return Err(error);
        }
        let mut session = collaboration::discover(provider).await;
        session.account = credentials
            .as_ref()
            .and_then(Credentials::account_id)
            .map(str::to_owned);
        Ok(session)
    }
}

#[cfg(test)]
mod tests;
