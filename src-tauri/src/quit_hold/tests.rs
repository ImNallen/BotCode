// Ported from T3 Code v0.0.45 apps/desktop/src/window/QuitHold.test.ts (MIT).
use std::time::{Duration, Instant};

use super::{DOUBLE_PRESS, Effect, HOLD, Hint, Key, KeyEvent, Mode, QuitHold, RELEASE_GRACE};

const DOWN_HOLD: &str = "down:hold";
const DOWN_DOUBLE: &str = "down:double-click";
const UP: &str = "up";

struct Harness {
    machine: QuitHold,
    mode: Mode,
    now: Instant,
    timers: Vec<(Instant, u64)>,
    notifications: Vec<&'static str>,
    conceals: usize,
    quits: usize,
    swallowed: usize,
    mode_reads: usize,
}

fn harness(mode: Mode) -> Harness {
    Harness {
        machine: QuitHold::default(),
        mode,
        now: Instant::now(),
        timers: Vec::new(),
        notifications: Vec::new(),
        conceals: 0,
        quits: 0,
        swallowed: 0,
        mode_reads: 0,
    }
}

fn q() -> KeyEvent {
    KeyEvent::Down {
        key: Key::Q,
        modifier: true,
        other_modifier: false,
        repeat: false,
    }
}

fn repeat() -> KeyEvent {
    KeyEvent::Down {
        key: Key::Q,
        modifier: true,
        other_modifier: false,
        repeat: true,
    }
}

fn down(key: Key, modifier: bool, other_modifier: bool) -> KeyEvent {
    KeyEvent::Down {
        key,
        modifier,
        other_modifier,
        repeat: false,
    }
}

impl Harness {
    fn apply(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Show(Hint::Hold) => self.notifications.push(DOWN_HOLD),
                Effect::Show(Hint::DoublePress) => self.notifications.push(DOWN_DOUBLE),
                Effect::Hide => self.notifications.push(UP),
                Effect::Conceal => self.conceals += 1,
                Effect::Quit => self.quits += 1,
                Effect::Schedule { after, token } => self.timers.push((self.now + after, token)),
            }
        }
    }

    fn send(&mut self, event: KeyEvent) {
        let mode = self.mode;
        let reads = &mut self.mode_reads;
        let (swallow, effects) = self.machine.key(event, self.now, || {
            *reads += 1;
            mode
        });
        self.swallowed += usize::from(swallow);
        self.apply(effects);
    }

    fn advance(&mut self, ms: u64) {
        let until = self.now + Duration::from_millis(ms);
        loop {
            self.timers.sort_by_key(|(at, _)| *at);
            let Some(&(at, token)) = self.timers.first().filter(|(at, _)| *at <= until) else {
                break;
            };
            self.timers.remove(0);
            self.now = at;
            let effects = self.machine.timer(token);
            self.apply(effects);
        }
        self.now = until;
    }

    fn hold_for(&mut self, duration: Duration, event: KeyEvent, interval: u64) {
        let mut elapsed = 0;
        while elapsed < duration.as_millis() as u64 {
            self.advance(interval);
            self.send(event);
            elapsed += interval;
        }
    }

    fn hold(&mut self, duration: Duration) {
        self.hold_for(duration, repeat(), 100);
    }
}

fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
}

#[test]
fn shows_the_hint_on_a_tap_without_quitting_even_when_the_release_is_never_seen() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    assert_eq!(h.swallowed, 1);
    assert_eq!(h.notifications, [DOWN_HOLD]);
    h.advance((HOLD + RELEASE_GRACE).as_millis() as u64);
    assert_eq!(h.quits, 0);
    assert_eq!(h.notifications, [DOWN_HOLD, UP]);
}

#[test]
fn conceals_a_completed_hold_then_quits_after_release() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(HOLD + ms(200));
    assert_eq!(h.conceals, 1);
    assert_eq!(h.quits, 0);
    h.send(KeyEvent::Up(Key::Modifier));
    assert_eq!(h.quits, 0);
    h.advance(RELEASE_GRACE.as_millis() as u64);
    assert_eq!(h.quits, 1);
    assert_eq!(h.notifications, [DOWN_HOLD, UP]);
}

#[test]
fn keeps_a_concealed_hold_committed_when_another_key_is_pressed() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(HOLD);
    h.send(down(Key::Other, true, true));
    assert_eq!(h.conceals, 1);
    assert_eq!(h.quits, 0);
    h.advance(RELEASE_GRACE.as_millis() as u64);
    assert_eq!(h.quits, 1);
}

#[test]
fn keeps_a_concealed_hold_committed_through_a_fresh_quit_press() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(HOLD);
    h.send(q());
    assert_eq!(h.conceals, 1);
    assert_eq!(h.quits, 0);
    h.send(KeyEvent::Up(Key::Q));
    assert_eq!(h.quits, 1);
}

#[test]
fn quits_when_a_completed_hold_goes_quiet_without_release_events() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(HOLD + RELEASE_GRACE * 2);
    assert_eq!(h.quits, 0);
    h.advance(RELEASE_GRACE.as_millis() as u64);
    assert_eq!(h.quits, 1);
    assert_eq!(h.notifications, [DOWN_HOLD, UP]);
}

#[test]
fn waits_for_slow_repeats_to_stop_before_quitting() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.advance(300);
    h.send(repeat());
    h.advance(900);
    h.send(repeat());
    h.advance(RELEASE_GRACE.as_millis() as u64);
    assert_eq!(h.quits, 0);
    h.advance(300);
    h.send(repeat());
    h.advance(1_799);
    assert_eq!(h.quits, 0);
    h.advance(1);
    assert_eq!(h.quits, 1);
}

#[test]
fn follows_a_repeat_cadence_that_slows_after_the_hold_completes() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(HOLD + ms(100));
    assert_eq!(h.conceals, 1);
    h.advance(500);
    h.send(repeat());
    h.advance(999);
    assert_eq!(h.quits, 0);
    h.advance(1);
    assert_eq!(h.quits, 1);
}

#[test]
fn uses_the_initial_repeat_delay_when_the_first_repeat_completes_the_hold() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.advance((HOLD + ms(100)).as_millis() as u64);
    h.send(repeat());
    h.advance(RELEASE_GRACE.as_millis() as u64);
    assert_eq!(h.quits, 0);
    h.advance(1_999);
    assert_eq!(h.quits, 0);
    h.advance(1);
    assert_eq!(h.quits, 1);
}

#[test]
fn waits_for_q_release_when_the_modifier_is_released_first() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(HOLD + ms(200));
    h.send(KeyEvent::Up(Key::Modifier));
    let swallowed = h.swallowed;
    let unmodified = KeyEvent::Down {
        key: Key::Q,
        modifier: false,
        other_modifier: false,
        repeat: true,
    };
    h.hold_for(RELEASE_GRACE * 2, unmodified, 100);
    assert!(h.swallowed > swallowed);
    assert_eq!(h.quits, 0);
    h.send(KeyEvent::Up(Key::Q));
    assert_eq!(h.quits, 1);
}

#[test]
fn commits_a_concealed_hold_when_the_last_q_repeat_is_never_released() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(HOLD + ms(200));
    h.send(KeyEvent::Up(Key::Modifier));
    h.send(KeyEvent::Down {
        key: Key::Q,
        modifier: false,
        other_modifier: false,
        repeat: true,
    });
    h.advance(RELEASE_GRACE.as_millis() as u64);
    assert_eq!(h.quits, 1);

    h.send(down(Key::Modifier, true, false));
    h.send(KeyEvent::Up(Key::Modifier));
    h.advance((RELEASE_GRACE * 4).as_millis() as u64);
    assert_eq!(
        h.quits, 1,
        "a lone modifier tap afterwards must not quit again"
    );
}

#[test]
fn does_not_quit_when_the_hold_stops_before_the_duration() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(ms(500));
    h.send(KeyEvent::Up(Key::Q));
    assert_eq!(h.notifications, [DOWN_HOLD, UP]);
    h.advance(((HOLD + RELEASE_GRACE) * 2).as_millis() as u64);
    assert_eq!(h.conceals, 0);
    assert_eq!(h.quits, 0);
}

#[test]
fn cancels_the_hold_when_the_modifier_is_released_first() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.send(KeyEvent::Up(Key::Modifier));
    assert_eq!(h.notifications, [DOWN_HOLD, UP]);
    h.advance(((HOLD + RELEASE_GRACE) * 2).as_millis() as u64);
    assert_eq!(h.quits, 0);
}

#[test]
fn quits_without_showing_a_hint_in_direct_mode() {
    let mut h = harness(Mode::Direct);
    h.send(q());
    assert_eq!(h.swallowed, 1);
    assert_eq!(h.conceals, 0);
    assert_eq!(h.quits, 1);
    assert!(h.notifications.is_empty());
}

#[test]
fn quits_on_a_quick_second_press_without_reading_the_mode_again() {
    for mode in [Mode::Hold, Mode::DoublePress] {
        let mut h = harness(mode);
        h.send(q());
        h.send(KeyEvent::Up(Key::Q));
        h.advance((DOUBLE_PRESS - ms(100)).as_millis() as u64);
        h.send(q());
        assert_eq!(h.mode_reads, 1, "{mode:?}");
        assert_eq!(h.quits, 1, "{mode:?}");
    }
}

#[test]
fn quits_on_a_quick_double_press_in_double_mode_when_the_first_release_is_unseen() {
    let mut h = harness(Mode::DoublePress);
    h.send(q());
    h.advance((DOUBLE_PRESS - ms(100)).as_millis() as u64);
    h.send(q());
    assert_eq!(h.conceals, 0);
    assert_eq!(h.quits, 1);
    assert_eq!(h.notifications, [DOWN_DOUBLE, UP]);
}

#[test]
fn keeps_the_double_press_hint_visible_after_key_release_until_the_window_ends() {
    let mut h = harness(Mode::DoublePress);
    h.send(q());
    h.advance(100);
    h.send(KeyEvent::Up(Key::Q));
    assert_eq!(h.notifications, [DOWN_DOUBLE]);
    h.advance((DOUBLE_PRESS - ms(101)).as_millis() as u64);
    assert_eq!(h.notifications, [DOWN_DOUBLE]);
    h.advance(1);
    assert_eq!(h.notifications, [DOWN_DOUBLE, UP]);
}

#[test]
fn accepts_a_second_full_chord_after_the_modifier_is_released_and_pressed_again() {
    let mut h = harness(Mode::DoublePress);
    h.send(q());
    h.send(KeyEvent::Up(Key::Q));
    h.send(KeyEvent::Up(Key::Modifier));
    h.advance(100);
    h.send(down(Key::Modifier, true, false));
    h.send(q());
    assert_eq!(h.quits, 1);
    assert_eq!(h.notifications, [DOWN_DOUBLE, UP]);
}

#[test]
fn treats_two_slow_presses_as_separate_attempts_in_double_mode() {
    let mut h = harness(Mode::DoublePress);
    h.send(q());
    h.send(KeyEvent::Up(Key::Q));
    h.advance((DOUBLE_PRESS + ms(100)).as_millis() as u64);
    h.send(q());
    assert_eq!(h.quits, 0);
    assert_eq!(h.notifications, [DOWN_DOUBLE, UP, DOWN_DOUBLE]);
}

#[test]
fn quits_on_a_quick_second_press_in_hold_mode() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.send(KeyEvent::Up(Key::Q));
    h.advance((DOUBLE_PRESS - ms(100)).as_millis() as u64);
    h.send(q());
    assert_eq!(h.quits, 1);
    assert_eq!(h.notifications, [DOWN_HOLD, UP]);
}

#[test]
fn quits_on_a_quick_second_press_in_hold_mode_when_the_first_release_is_unseen() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.advance((DOUBLE_PRESS - ms(100)).as_millis() as u64);
    h.send(q());
    assert_eq!(h.conceals, 0);
    assert_eq!(h.quits, 1);
    assert_eq!(h.notifications, [DOWN_HOLD, UP]);
}

#[test]
fn quits_on_a_second_press_exactly_at_the_double_press_limit_but_not_after() {
    let mut h = harness(Mode::DoublePress);
    h.send(q());
    h.advance(DOUBLE_PRESS.as_millis() as u64);
    h.send(q());
    assert_eq!(h.quits, 1);

    let mut h = harness(Mode::Hold);
    h.send(q());
    h.send(KeyEvent::Up(Key::Q));
    h.advance((DOUBLE_PRESS + ms(1)).as_millis() as u64);
    h.send(q());
    assert_eq!(h.quits, 0);
}

#[test]
fn does_not_count_auto_repeat_as_a_second_press() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(DOUBLE_PRESS - ms(100));
    assert_eq!(h.quits, 0);
    assert_eq!(h.notifications, [DOWN_HOLD]);
}

#[test]
fn does_not_count_a_released_tap_after_another_shortcut_interrupts_it() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.send(KeyEvent::Up(Key::Q));
    h.send(down(Key::Other, true, false));
    h.advance(100);
    h.send(q());
    assert_eq!(h.quits, 0);
    assert_eq!(h.notifications, [DOWN_HOLD, UP, DOWN_HOLD]);
}

#[test]
fn typing_q_without_the_modifier_cancels_the_double_press_window() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.send(KeyEvent::Up(Key::Q));
    h.send(KeyEvent::Up(Key::Modifier));
    h.send(down(Key::Q, false, false));
    assert_eq!(h.swallowed, 1, "plain q reaches the app");
    h.advance(100);
    h.send(q());
    assert_eq!(h.quits, 0);
}

#[test]
fn cancels_the_hold_when_another_key_interrupts_it() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    h.hold(ms(500));
    h.send(down(Key::Q, true, true));
    assert_eq!(h.notifications, [DOWN_HOLD, UP]);
    h.hold(HOLD);
    assert_eq!(h.quits, 0);
    assert_eq!(h.conceals, 0);
}

#[test]
fn does_not_count_an_interrupted_press_toward_a_double_press() {
    let mut h = harness(Mode::DoublePress);
    h.send(q());
    h.send(down(Key::Q, true, true));
    h.send(q());
    assert_eq!(h.quits, 0);
    assert_eq!(h.notifications, [DOWN_DOUBLE, UP, DOWN_DOUBLE]);
}

#[test]
fn ignores_and_passes_through_other_shortcuts() {
    let mut h = harness(Mode::Hold);
    h.send(down(Key::Other, true, false));
    h.send(down(Key::Q, true, true));
    h.send(down(Key::Q, false, false));
    assert_eq!(h.swallowed, 0);
    assert!(h.notifications.is_empty());
    assert_eq!(h.mode_reads, 0);
}

#[test]
fn ignores_a_superseded_timer() {
    let mut h = harness(Mode::Hold);
    h.send(q());
    let (_, first) = *h.timers.first().expect("the hold watchdog is scheduled");
    h.send(KeyEvent::Up(Key::Q));
    h.advance((DOUBLE_PRESS + ms(100)).as_millis() as u64);
    h.send(q());
    h.advance(HOLD.as_millis() as u64);
    assert!(h.machine.timer(first).is_empty());
    assert_eq!(h.notifications, [DOWN_HOLD, UP, DOWN_HOLD]);
    h.hold(ms(200));
    assert_eq!(h.conceals, 1, "the second press still completes its hold");
}

#[test]
fn reads_the_mode_on_each_fresh_press() {
    let mut h = harness(Mode::DoublePress);
    h.send(q());
    h.send(KeyEvent::Up(Key::Q));
    h.advance((DOUBLE_PRESS + ms(100)).as_millis() as u64);
    h.mode = Mode::Hold;
    h.send(q());
    assert_eq!(h.notifications, [DOWN_DOUBLE, UP, DOWN_HOLD]);
    h.send(KeyEvent::Up(Key::Q));
    h.advance((DOUBLE_PRESS + ms(100)).as_millis() as u64);
    h.mode = Mode::Direct;
    h.send(q());
    assert_eq!(h.quits, 1);
    assert_eq!(h.mode_reads, 3);
}

#[test]
fn reads_confirm_quit_from_settings_and_defaults_to_hold() {
    let dir = std::env::temp_dir().join(format!("bot-code-quit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("settings.json");
    assert_eq!(super::mode(&path), Mode::Hold);
    for (text, expected) in [
        (r#"{"confirmQuit":"direct"}"#, Mode::Direct),
        (r#"{"confirmQuit":"hold"}"#, Mode::Hold),
        (r#"{"confirmQuit":"double-click"}"#, Mode::DoublePress),
        (r#"{"confirmQuit":"later"}"#, Mode::Hold),
        (r#"{"confirmQuit":false}"#, Mode::Hold),
        ("not json", Mode::Hold),
    ] {
        std::fs::write(&path, text).unwrap();
        assert_eq!(super::mode(&path), expected, "{text}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}
