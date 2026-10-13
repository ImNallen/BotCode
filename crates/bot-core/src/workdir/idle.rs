//! The idle rule for sandboxes: a pure decision over an activity record. The owner tick folds
//! what it knows into the record and asks what the container should be.
use crate::sandbox::{Desired, Probe};
use std::time::{Duration, Instant};

/// A probe interval at or above this share of one CPU counts as activity. It catches terminal
/// jobs, dev servers and builds that no Bot Code entry point sees. Measured in the image, an
/// idle container with a live agent and a shown terminal reads 2.1 to 2.4%: the idle agent,
/// the terminal label poll at about 8 ms per second, and the probe itself at 12 ms. The
/// threshold stays clear of Bot Code's own observation; real work reads far higher.
pub(crate) const CPU_BUSY_PERCENT: f64 = 5.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Limits {
    pub pause_after: Duration,
    pub stop_after: Duration,
    pub desktop_idle: Duration,
}
impl Limits {
    pub const DEFAULT: Self = Self {
        pause_after: Duration::from_secs(10 * 60),
        stop_after: Duration::from_secs(2 * 60 * 60),
        desktop_idle: Duration::from_secs(3 * 60),
    };
    /// The defaults, each overridable in seconds for verification: `BOT_CODE_SANDBOX_PAUSE_AFTER_SECS`,
    /// `BOT_CODE_SANDBOX_STOP_AFTER_SECS` and `BOT_CODE_SANDBOX_DESKTOP_IDLE_SECS`.
    pub fn from_environment() -> Self {
        let seconds = |name: &str, default: Duration| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.trim().parse().ok())
                .map_or(default, Duration::from_secs)
        };
        Self {
            pause_after: seconds(
                "BOT_CODE_SANDBOX_PAUSE_AFTER_SECS",
                Self::DEFAULT.pause_after,
            ),
            stop_after: seconds("BOT_CODE_SANDBOX_STOP_AFTER_SECS", Self::DEFAULT.stop_after),
            desktop_idle: seconds(
                "BOT_CODE_SANDBOX_DESKTOP_IDLE_SECS",
                Self::DEFAULT.desktop_idle,
            ),
        }
    }
    /// How often a running container is probed: a twentieth of the pause window, within
    /// bounds. The floor keeps the probe's own 12 ms under the CPU threshold, so an override
    /// has to leave a few seconds for the desktop window and the pause.
    pub fn probe_every(&self) -> Duration {
        (self.pause_after / 20).clamp(Duration::from_secs(2), Duration::from_secs(30))
    }
    /// How often the owner evaluates the rule, which is also how late a probe can be. The
    /// rule itself is a few comparisons.
    pub fn tick(&self) -> Duration {
        self.probe_every().min(Duration::from_secs(1))
    }
}

/// What the idle rule reads about one sandbox. Each instant is the last moment a condition
/// held, so "idle for the whole window" is "every instant is older than the window".
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Activity {
    /// The last use through Bot Code: a message, terminal input or attach, a Desktop open, a
    /// write, a rewind, a git action, a wake.
    pub touched: Instant,
    /// The last tick at which a thread of the sandbox had a running turn, an open approval or
    /// question, or a hold on its checkout.
    pub busy: Instant,
    /// The last probe interval whose CPU share reached [`CPU_BUSY_PERCENT`].
    pub cpu: Instant,
    /// The last probe that found a Desktop tab connected, or the last Desktop open.
    pub desktop_client: Instant,
    pub desktop_running: bool,
    /// The previous probe, which the next one is measured against.
    probed: Option<(Instant, Duration)>,
}
impl Activity {
    pub fn new(now: Instant) -> Self {
        Self {
            touched: now,
            busy: now,
            cpu: now,
            desktop_client: now,
            desktop_running: false,
            probed: None,
        }
    }
    pub fn idle_for(&self, now: Instant) -> Duration {
        let latest = self
            .touched
            .max(self.busy)
            .max(self.cpu)
            .max(self.desktop_client);
        now.saturating_duration_since(latest)
    }
    /// What the container should be, given how long nothing has used it.
    pub fn desired(&self, now: Instant, limits: &Limits) -> Desired {
        let idle = self.idle_for(now);
        if idle >= limits.stop_after {
            Desired::Stopped
        } else if idle >= limits.pause_after {
            Desired::Paused
        } else {
            Desired::Running
        }
    }
    /// Whether the desktop has run with no Desktop tab connected and no turn for the window.
    /// Terminal input does not keep it, because the shell does not use the screen.
    pub fn desktop_idle(&self, now: Instant, limits: &Limits) -> bool {
        self.desktop_running
            && now.saturating_duration_since(self.busy.max(self.desktop_client))
                >= limits.desktop_idle
    }
    /// Folds a probe in. Returns the interval's CPU share of one CPU, which the first probe
    /// after a start cannot give, nor one after the container's counter was reset.
    pub fn observe(&mut self, now: Instant, probe: &Probe) -> Option<f64> {
        let percent = self.probed.and_then(|(at, cpu)| {
            let wall = now.saturating_duration_since(at).as_secs_f64();
            let used = probe.cpu.checked_sub(cpu)?.as_secs_f64();
            (wall > 0.0).then(|| used / wall * 100.0)
        });
        if percent.is_some_and(|percent| percent >= CPU_BUSY_PERCENT) {
            self.cpu = now;
        }
        if probe.desktop_clients > 0 {
            self.desktop_client = now;
        }
        self.desktop_running = probe.desktop_running;
        self.probed = Some((now, probe.cpu));
        percent
    }
    /// A container that stopped running starts its CPU counter again when it runs next.
    pub fn forget_probe(&mut self) {
        self.probed = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: Limits = Limits {
        pause_after: Duration::from_secs(600),
        stop_after: Duration::from_secs(7200),
        desktop_idle: Duration::from_secs(180),
    };
    fn probe(cpu_secs: f64, clients: u32, desktop: bool) -> Probe {
        Probe {
            cpu: Duration::from_secs_f64(cpu_secs),
            desktop_clients: clients,
            desktop_running: desktop,
        }
    }
    fn after(start: Instant, secs: u64) -> Instant {
        start + Duration::from_secs(secs)
    }

    #[test]
    fn a_sandbox_pauses_after_the_window_and_stops_after_the_longer_one() {
        let start = Instant::now();
        let record = Activity::new(start);
        assert_eq!(record.desired(start, &LIMITS), Desired::Running);
        assert_eq!(record.desired(after(start, 599), &LIMITS), Desired::Running);
        assert_eq!(record.desired(after(start, 600), &LIMITS), Desired::Paused);
        assert_eq!(record.desired(after(start, 7199), &LIMITS), Desired::Paused);
        assert_eq!(
            record.desired(after(start, 7200), &LIMITS),
            Desired::Stopped
        );
    }

    #[test]
    fn each_kind_of_activity_restarts_the_window() {
        let start = Instant::now();
        let mut touched = Activity::new(start);
        touched.touched = after(start, 500);
        let mut busy = Activity::new(start);
        busy.busy = after(start, 500);
        let mut client = Activity::new(start);
        assert_eq!(
            client.observe(after(start, 499), &probe(0.0, 0, true)),
            None,
            "the first probe has nothing to compare with"
        );
        client.observe(after(start, 500), &probe(0.0, 1, true));
        let mut cpu = Activity::new(start);
        cpu.observe(after(start, 490), &probe(10.0, 0, false));
        assert_eq!(
            cpu.observe(after(start, 500), &probe(10.5, 0, false)),
            Some(5.0),
            "half a second of CPU over ten seconds is five percent"
        );
        for (name, record) in [
            ("touch", touched),
            ("turn", busy),
            ("desktop client", client),
            ("cpu", cpu),
        ] {
            assert_eq!(
                record.desired(after(start, 1099), &LIMITS),
                Desired::Running,
                "{name}"
            );
            assert_eq!(
                record.desired(after(start, 1100), &LIMITS),
                Desired::Paused,
                "{name}"
            );
        }
    }

    #[test]
    fn cpu_under_the_threshold_a_first_probe_and_a_reset_counter_are_not_activity() {
        let start = Instant::now();
        let mut record = Activity::new(start);
        assert_eq!(
            record.observe(after(start, 10), &probe(100.0, 0, false)),
            None
        );
        let percent = record
            .observe(after(start, 20), &probe(100.49, 0, false))
            .unwrap();
        assert!((percent - 4.9).abs() < 1e-9, "{percent}");
        assert_eq!(record.cpu, start, "4.9 percent is under the threshold");
        assert_eq!(
            record.observe(after(start, 30), &probe(1.0, 0, false)),
            None,
            "a smaller counter means the container restarted"
        );
        assert_eq!(record.cpu, start);
        let percent = record
            .observe(after(start, 40), &probe(1.5, 0, false))
            .unwrap();
        assert!((percent - 5.0).abs() < 1e-9, "{percent}");
        assert_eq!(
            record.cpu,
            after(start, 40),
            "five percent reaches the threshold"
        );
        record.forget_probe();
        assert_eq!(
            record.observe(after(start, 50), &probe(0.0, 0, false)),
            None
        );
    }

    #[test]
    fn the_desktop_is_idle_without_a_tab_or_a_turn_whatever_the_terminal_does() {
        let start = Instant::now();
        let mut record = Activity::new(start);
        record.observe(start, &probe(0.0, 1, true));
        assert!(!record.desktop_idle(after(start, 179), &LIMITS));
        assert!(record.desktop_idle(after(start, 180), &LIMITS));
        record.touched = after(start, 170);
        assert!(
            record.desktop_idle(after(start, 180), &LIMITS),
            "terminal input does not use the screen"
        );
        record.busy = after(start, 170);
        assert!(
            !record.desktop_idle(after(start, 180), &LIMITS),
            "a turn may use it"
        );
        assert!(record.desktop_idle(after(start, 350), &LIMITS));
        record.observe(after(start, 300), &probe(0.0, 1, true));
        assert!(
            !record.desktop_idle(after(start, 350), &LIMITS),
            "a tab is connected"
        );
        record.observe(after(start, 400), &probe(0.0, 0, false));
        assert!(
            !record.desktop_idle(after(start, 900), &LIMITS),
            "nothing runs to stop"
        );
        assert_eq!(
            record.desired(after(start, 900), &LIMITS),
            Desired::Paused,
            "the connected tab at 300 kept the sandbox running until 900"
        );
    }

    #[test]
    fn probes_come_often_enough_for_short_overrides() {
        assert_eq!(LIMITS.probe_every(), Duration::from_secs(30));
        let short = Limits {
            pause_after: Duration::from_secs(2),
            ..LIMITS
        };
        assert_eq!(short.probe_every(), Duration::from_secs(2));
        assert_eq!(short.tick(), Duration::from_secs(1));
        assert_eq!(LIMITS.tick(), Duration::from_secs(1));
        let long = Limits {
            pause_after: Duration::from_secs(3600),
            ..LIMITS
        };
        assert_eq!(long.probe_every(), Duration::from_secs(30));
    }
}
