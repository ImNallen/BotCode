use std::time::{Duration, Instant};

const HEALTHY: Duration = Duration::from_secs(60);
const CAP: Duration = Duration::from_secs(30);

/// Capped exponential backoff between Codex launches after consecutive failures.
#[derive(Default)]
pub(super) struct Restarts {
    failures: u32,
    ready_at: Option<Instant>,
    not_before: Option<Instant>,
}
impl Restarts {
    pub(super) fn ready(&mut self, now: Instant) {
        self.ready_at = Some(now);
    }
    pub(super) fn lost(&mut self, now: Instant) {
        if self
            .ready_at
            .is_some_and(|at| now.duration_since(at) >= HEALTHY)
        {
            self.failures = 0;
        }
        self.failures += 1;
        self.ready_at = None;
        self.not_before = Some(now + backoff(self.failures));
    }
    pub(super) fn delay(&self, now: Instant) -> Duration {
        self.not_before
            .map_or(Duration::ZERO, |at| at.saturating_duration_since(now))
    }
    pub(super) fn failures(&self) -> u32 {
        self.failures
    }
    /// The banner for work that waits on a delayed launch.
    pub(super) fn notice(&self, now: Instant) -> Option<String> {
        let delay = self.delay(now);
        if delay.is_zero() {
            return None;
        }
        let seconds = whole_seconds(delay);
        let unit = if seconds == 1 { "second" } else { "seconds" };
        Some(format!(
            "Codex stopped {} times in a row. Bot Code restarts it in {seconds} {unit}.",
            self.failures
        ))
    }
}
pub(super) fn whole_seconds(delay: Duration) -> u128 {
    delay.as_millis().div_ceil(1000)
}
fn backoff(failures: u32) -> Duration {
    match failures {
        0 | 1 => Duration::ZERO,
        n => Duration::from_secs(1 << (n - 2).min(5)).min(CAP),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(failures: usize) -> Vec<u64> {
        let start = Instant::now();
        let mut restarts = Restarts::default();
        (0..failures)
            .map(|n| {
                let now = start + Duration::from_secs(n as u64);
                restarts.lost(now);
                restarts.delay(now).as_secs()
            })
            .collect()
    }

    #[test]
    fn consecutive_failures_back_off_exponentially_up_to_thirty_seconds() {
        assert_eq!(schedule(9), [0, 1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(schedule(80).last(), Some(&30));
    }

    #[test]
    fn delay_counts_down_from_the_failure() {
        let start = Instant::now();
        let mut restarts = Restarts::default();
        assert_eq!(restarts.delay(start), Duration::ZERO);
        restarts.lost(start);
        restarts.lost(start);
        restarts.lost(start);
        assert_eq!(restarts.failures(), 3);
        assert_eq!(restarts.delay(start), Duration::from_secs(2));
        assert_eq!(
            restarts.delay(start + Duration::from_millis(1500)),
            Duration::from_millis(500)
        );
        assert_eq!(
            restarts.delay(start + Duration::from_secs(5)),
            Duration::ZERO
        );
    }

    #[test]
    fn notice_names_the_failures_and_the_remaining_wait() {
        let start = Instant::now();
        let mut restarts = Restarts::default();
        restarts.lost(start);
        assert_eq!(restarts.notice(start), None);
        restarts.lost(start);
        assert_eq!(
            restarts.notice(start).as_deref(),
            Some("Codex stopped 2 times in a row. Bot Code restarts it in 1 second.")
        );
        restarts.lost(start);
        assert_eq!(
            restarts
                .notice(start + Duration::from_millis(100))
                .as_deref(),
            Some("Codex stopped 3 times in a row. Bot Code restarts it in 2 seconds.")
        );
        assert_eq!(restarts.notice(start + Duration::from_secs(2)), None);
    }

    #[test]
    fn a_minute_of_healthy_uptime_resets_the_count() {
        let start = Instant::now();
        let mut restarts = Restarts::default();
        for _ in 0..4 {
            restarts.lost(start);
        }
        restarts.ready(start);
        restarts.lost(start + Duration::from_secs(59));
        assert_eq!(restarts.failures(), 5);
        assert_eq!(
            restarts.delay(start + Duration::from_secs(59)),
            Duration::from_secs(8)
        );
        let later = start + Duration::from_secs(100);
        restarts.ready(later);
        restarts.lost(later + HEALTHY);
        assert_eq!(restarts.failures(), 1);
        assert_eq!(restarts.delay(later + HEALTHY), Duration::ZERO);
    }

    #[test]
    fn a_launch_failure_without_readiness_never_resets() {
        let start = Instant::now();
        let mut restarts = Restarts::default();
        restarts.lost(start);
        restarts.lost(start + Duration::from_secs(600));
        assert_eq!(restarts.failures(), 2);
    }
}
