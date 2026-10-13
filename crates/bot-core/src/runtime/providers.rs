//! One app-server slot per execution environment.
use super::{
    Prepare,
    collaboration::{self, ModePreset, ProviderSession},
    restarts::Restarts,
};
use crate::{
    codex::{AgentProcess, Codex, Signal},
    diagnostics::ProviderPids,
    domain::*,
    log::RotatingLog,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

/// Which app-server a thread talks to. Derived from the checkout, never stored. Threads that
/// share a sandbox checkout share its agent.
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

/// Epochs come from one counter shared by every slot, so an epoch names exactly one process
/// generation of one slot. Signals, completions and callback routes keep a bare epoch, and an
/// epoch that no slot holds any more is stale.
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
    /// The live process for `key` and its epoch.
    pub(super) fn client(&self, key: &EnvKey) -> Option<(u64, Codex)> {
        match &self.slots.get(key)?.state {
            SlotState::Live { epoch, codex, .. } => Some((*epoch, codex.clone())),
            _ => None,
        }
    }
    /// The slot that is launching or live under `epoch`.
    pub(super) fn key(&self, epoch: u64) -> Option<&EnvKey> {
        self.slots
            .iter()
            .find(|(_, slot)| slot.state.epoch() == Some(epoch))
            .map(|(key, _)| key)
    }
    pub(super) fn current(&self, epoch: u64) -> bool {
        self.key(epoch).is_some()
    }
    /// The process live under `epoch`, with its slot.
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
    /// `None` while the slot is already launching or live.
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
    /// Makes the launching slot live and returns the jobs that waited for it.
    pub(super) fn launched(
        &mut self,
        key: &EnvKey,
        codex: Codex,
        modes: Vec<ModePreset>,
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
    /// Retires the slot's epoch and drops its queued jobs. A launching or live slot counts a
    /// failure toward its own backoff unless Bot Code is closing.
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
    /// A deliberate stop retires the epoch without counting a failure. The process's later
    /// `Exited` carries the retired epoch, so it is dropped like any stale signal.
    pub(super) fn stop(&mut self, key: &EnvKey) -> Option<Codex> {
        let slot = self.slots.get_mut(key)?;
        match std::mem::take(&mut slot.state) {
            SlotState::Live { codex, .. } => Some(codex),
            launching => {
                slot.state = launching;
                None
            }
        }
    }
}

/// The one place an agent process starts.
pub(super) enum Launcher {
    Mac { binary: PathBuf },
    Sandbox,
}
impl Launcher {
    pub(super) fn new(key: &EnvKey, binary: PathBuf) -> Self {
        match key {
            EnvKey::Mac => Self::Mac { binary },
            EnvKey::Sandbox(_) => Self::Sandbox,
        }
    }
    pub(super) async fn start(
        self,
        epoch: u64,
        events: mpsc::Sender<Signal>,
        log: RotatingLog,
        pids: ProviderPids,
    ) -> Result<ProviderSession> {
        let process = match self {
            Self::Mac { binary } => AgentProcess::mac(&binary),
            Self::Sandbox => {
                return Err(AppError::new(
                    "sandbox_unavailable",
                    "Sandbox threads are not available yet.",
                ));
            }
        };
        let provider = Codex::launch(process, epoch, events, log, pids).await?;
        if let Err(error) = provider.initialize().await {
            let _ = provider.terminate().await;
            return Err(error);
        }
        Ok(collaboration::discover(provider).await)
    }
}

#[cfg(test)]
mod tests;
