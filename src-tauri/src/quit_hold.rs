// Ported from T3 Code v0.0.45 apps/desktop/src/window/QuitHold.ts (MIT).
use std::{
    path::Path,
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{install, is_quit_chord};

pub const HOLD: Duration = Duration::from_millis(1200);
pub const DOUBLE_PRESS: Duration = Duration::from_millis(500);
// "Still held" is proven by auto-repeat keydowns, not by the absence of a
// release: macOS suppresses a letter keyUp while Command is down, so a tap
// release can go unseen. Once held, quitting waits for Q keyUp or a quiet
// period after repeats stop so they cannot reach the next app.
pub const RELEASE_GRACE: Duration = Duration::from_millis(600);
const REPEAT_CADENCE_MULTIPLIER: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Direct,
    Hold,
    DoublePress,
}

pub fn mode(settings: &Path) -> Mode {
    let value = std::fs::read(settings)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    match value
        .as_ref()
        .and_then(|value| value["confirmQuit"].as_str())
    {
        Some("direct") => Mode::Direct,
        Some("double-click") => Mode::DoublePress,
        _ => Mode::Hold,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Hint {
    #[serde(rename = "hold")]
    Hold,
    #[serde(rename = "double-click")]
    DoublePress,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Q,
    Modifier,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyEvent {
    Down {
        key: Key,
        modifier: bool,
        other_modifier: bool,
        repeat: bool,
    },
    Up(Key),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Show(Hint),
    Hide,
    Conceal,
    Quit,
    Schedule { after: Duration, token: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Holding {
        since: Instant,
        last_repeat: Option<Instant>,
    },
    DoubleHint,
    Committed {
        last_repeat: Instant,
        cadence: Duration,
    },
}

#[derive(Debug)]
pub struct QuitHold {
    phase: Phase,
    last_press: Option<Instant>,
    token: u64,
}

impl Default for QuitHold {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            last_press: None,
            token: 0,
        }
    }
}

impl QuitHold {
    pub fn key(
        &mut self,
        event: KeyEvent,
        now: Instant,
        mode: impl FnOnce() -> Mode,
    ) -> (bool, Vec<Effect>) {
        let mut effects = Vec::new();
        let (key, modifier, other_modifier, repeat) = match event {
            KeyEvent::Up(key) => {
                match (key, self.phase) {
                    (Key::Q, Phase::Committed { .. }) => {
                        self.release(&mut effects);
                        effects.push(Effect::Quit);
                    }
                    (Key::Q | Key::Modifier, Phase::Holding { .. }) => self.release(&mut effects),
                    (Key::Modifier, Phase::Committed { .. }) => self.quit_after_quiet(&mut effects),
                    _ => {}
                }
                return (false, effects);
            }
            KeyEvent::Down {
                key,
                modifier,
                other_modifier,
                repeat,
            } => (key, modifier, other_modifier, repeat),
        };

        if let Phase::Committed {
            last_repeat,
            cadence,
        } = &mut self.phase
        {
            if key == Key::Q {
                if repeat && modifier {
                    *cadence = now - *last_repeat;
                    *last_repeat = now;
                }
                self.quit_after_quiet(&mut effects);
            }
            return (true, effects);
        }

        if !modifier || other_modifier || key != Key::Q {
            if key == Key::Modifier && !other_modifier {
                return (false, effects);
            }
            if !repeat {
                self.last_press = None;
                self.release(&mut effects);
            }
            return (false, effects);
        }

        if repeat {
            if let Phase::Holding { since, last_repeat } = self.phase {
                if now - since >= HOLD {
                    self.phase = Phase::Committed {
                        last_repeat: now,
                        cadence: now - last_repeat.unwrap_or(since),
                    };
                    effects.push(Effect::Conceal);
                    self.quit_after_quiet(&mut effects);
                } else {
                    self.phase = Phase::Holding {
                        since,
                        last_repeat: Some(now),
                    };
                }
            }
            return (true, effects);
        }

        let previous = self.last_press.replace(now);
        self.release(&mut effects);
        if previous.is_some_and(|previous| now - previous <= DOUBLE_PRESS) {
            self.quit_now(&mut effects);
            return (true, effects);
        }
        match mode() {
            Mode::Direct => self.quit_now(&mut effects),
            Mode::DoublePress => {
                self.phase = Phase::DoubleHint;
                effects.push(Effect::Show(Hint::DoublePress));
                self.schedule(DOUBLE_PRESS, &mut effects);
            }
            Mode::Hold => {
                self.phase = Phase::Holding {
                    since: now,
                    last_repeat: None,
                };
                effects.push(Effect::Show(Hint::Hold));
                self.schedule(HOLD + RELEASE_GRACE, &mut effects);
            }
        }
        (true, effects)
    }

    pub fn timer(&mut self, token: u64) -> Vec<Effect> {
        let mut effects = Vec::new();
        if token != self.token {
            return effects;
        }
        match self.phase {
            Phase::Committed { .. } => self.quit_now(&mut effects),
            Phase::Holding { .. } | Phase::DoubleHint => self.release(&mut effects),
            Phase::Idle => {}
        }
        effects
    }

    fn schedule(&mut self, after: Duration, effects: &mut Vec<Effect>) {
        self.token += 1;
        effects.push(Effect::Schedule {
            after,
            token: self.token,
        });
    }

    fn release(&mut self, effects: &mut Vec<Effect>) {
        if self.phase != Phase::Idle {
            self.phase = Phase::Idle;
            self.token += 1;
            effects.push(Effect::Hide);
        }
    }

    fn quit_now(&mut self, effects: &mut Vec<Effect>) {
        self.release(effects);
        self.last_press = None;
        effects.push(Effect::Quit);
    }

    fn quit_after_quiet(&mut self, effects: &mut Vec<Effect>) {
        let Phase::Committed { cadence, .. } = self.phase else {
            return;
        };
        self.schedule(
            RELEASE_GRACE.max(cadence * REPEAT_CADENCE_MULTIPLIER),
            effects,
        );
    }
}

#[cfg(test)]
mod tests;
