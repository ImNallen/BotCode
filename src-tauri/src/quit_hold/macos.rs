// Adapted from T3 Code v0.0.45 apps/desktop/src/window/DesktopWindow.ts (MIT): quit shortcut wiring and concealPendingQuitWindow.
use std::{cell::RefCell, path::PathBuf, ptr::NonNull, time::Instant};

use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{
    NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSWindow, NSWindowStyleMask,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

use super::{Effect, Hint, Key, KeyEvent, QuitHold};

struct State {
    machine: QuitHold,
    app: AppHandle,
    settings: PathBuf,
    _monitor: Retained<AnyObject>,
}
thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

const Q_KEY_CODE: u16 = 12;

/// Watches key events before AppKit dispatches the menu's Command-Q `terminate:`, so a
/// held or double press can be required. Menu and Dock Quit stay immediate. Call on the
/// main thread.
pub fn install(app: &AppHandle, settings: PathBuf) {
    let handler = block2::RcBlock::new(|event: NonNull<NSEvent>| {
        // AppKit supplies a live event for the duration of this main-thread callback.
        let swallow = key_event(unsafe { event.as_ref() }).is_some_and(handle);
        if swallow {
            std::ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });
    // Returning the original event or null follows the AppKit monitor contract.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::KeyDown | NSEventMask::KeyUp | NSEventMask::FlagsChanged,
            &handler,
        )
    };
    let Some(monitor) = monitor else { return };
    STATE.with_borrow_mut(|state| {
        *state = Some(State {
            machine: QuitHold::default(),
            app: app.clone(),
            settings,
            _monitor: monitor,
        });
    });
}

/// Command-Q with no other modifier. Non-Latin layouts match the physical Q key, as
/// AppKit key equivalents do.
pub fn is_quit_chord(event: &NSEvent) -> bool {
    matches!(event.r#type(), NSEventType::KeyDown | NSEventType::KeyUp)
        && event
            .modifierFlags()
            .contains(NSEventModifierFlags::Command)
        && !event.modifierFlags().intersects(
            NSEventModifierFlags::Option
                | NSEventModifierFlags::Shift
                | NSEventModifierFlags::Control,
        )
        && is_q(event)
}

fn is_q(event: &NSEvent) -> bool {
    let characters = event
        .charactersIgnoringModifiers()
        .map(|text| text.to_string().to_lowercase())
        .unwrap_or_default();
    characters == "q"
        || (!(characters.len() == 1 && characters.as_bytes()[0].is_ascii_alphabetic())
            && event.keyCode() == Q_KEY_CODE)
}

fn key_event(event: &NSEvent) -> Option<KeyEvent> {
    let flags = event.modifierFlags();
    let modifier = flags.contains(NSEventModifierFlags::Command);
    let other_modifier = flags.intersects(
        NSEventModifierFlags::Option | NSEventModifierFlags::Shift | NSEventModifierFlags::Control,
    );
    match event.r#type() {
        NSEventType::KeyDown => Some(KeyEvent::Down {
            key: if is_q(event) { Key::Q } else { Key::Other },
            modifier,
            other_modifier,
            repeat: event.isARepeat(),
        }),
        NSEventType::KeyUp => is_q(event).then_some(KeyEvent::Up(Key::Q)),
        // Modifier presses arrive as flag changes. Their key codes name the key that moved.
        NSEventType::FlagsChanged => match event.keyCode() {
            54 | 55 if modifier => Some(KeyEvent::Down {
                key: Key::Modifier,
                modifier,
                other_modifier,
                repeat: false,
            }),
            54 | 55 => Some(KeyEvent::Up(Key::Modifier)),
            56 | 60 if flags.contains(NSEventModifierFlags::Shift) => Some(other(modifier)),
            58 | 61 if flags.contains(NSEventModifierFlags::Option) => Some(other(modifier)),
            59 | 62 if flags.contains(NSEventModifierFlags::Control) => Some(other(modifier)),
            _ => None,
        },
        _ => None,
    }
}

fn other(modifier: bool) -> KeyEvent {
    KeyEvent::Down {
        key: Key::Other,
        modifier,
        other_modifier: true,
        repeat: false,
    }
}

fn handle(event: KeyEvent) -> bool {
    let Some((swallow, effects, app)) = STATE.with_borrow_mut(|state| {
        let state = state.as_mut()?;
        let settings = &state.settings;
        let (swallow, effects) = state
            .machine
            .key(event, Instant::now(), || super::mode(settings));
        Some((swallow, effects, state.app.clone()))
    }) else {
        return false;
    };
    run(&app, effects);
    swallow
}

fn fire(token: u64) {
    let Some((effects, app)) = STATE.with_borrow_mut(|state| {
        let state = state.as_mut()?;
        Some((state.machine.timer(token), state.app.clone()))
    }) else {
        return;
    };
    run(&app, effects);
}

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum Payload {
    Down { mode: Hint },
    Up,
}

fn run(app: &AppHandle, effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::Show(mode) => emit(app, Payload::Down { mode }),
            Effect::Hide => emit(app, Payload::Up),
            Effect::Conceal => conceal(app),
            Effect::Quit => app.exit(0),
            Effect::Schedule { after, token } => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(after).await;
                    let _ = app.run_on_main_thread(move || fire(token));
                });
            }
        }
    }
}

fn emit(app: &AppHandle, payload: Payload) {
    let _ = app.emit_to(
        EventTarget::webview("main"),
        "l1code:quit-shortcut",
        payload,
    );
}

// The window stays key while transparent, so the remaining repeats cannot reach the next app.
fn conceal(app: &AppHandle) {
    let Some(pointer) = app
        .get_window("main")
        .and_then(|window| window.ns_window().ok())
    else {
        return;
    };
    // Tauri lends the main window's live NSWindow, and this runs on the main thread.
    let window = unsafe { &*pointer.cast::<NSWindow>() };
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        window.toggleFullScreen(None);
    }
    window.setAlphaValue(0.0);
}
