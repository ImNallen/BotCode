// Adapted from T3 v0.0.45 apps/desktop/src/preview/Manager.ts; native application shortcut routing.
use serde::{Deserialize, Serialize};

use super::{PreviewManager, model::Result};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shortcut {
    key: String,
    meta_key: bool,
    ctrl_key: bool,
    alt_key: bool,
    shift_key: bool,
}

pub fn validate(shortcuts: &[Shortcut]) -> Result<()> {
    if shortcuts.len() > 128
        || shortcuts.iter().any(|shortcut| {
            shortcut.key.is_empty()
                || shortcut.key.len() > 64
                || shortcut.key.chars().any(char::is_control)
                || !(shortcut.meta_key || shortcut.ctrl_key)
        })
    {
        return Err(
            "Preview application shortcuts must be bounded Command or Control chords.".into(),
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{cell::RefCell, collections::HashMap, ptr::NonNull};

    use objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject, sel};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSView};
    use objc2_foundation::NSObjectProtocol;
    use objc2_web_kit::WKWebView;
    use tauri::{Emitter, EventTarget, Manager, Webview};

    use super::{PreviewManager, Result, Shortcut};

    struct Monitor {
        token: Retained<AnyObject>,
        views: HashMap<String, Retained<WKWebView>>,
    }
    impl Drop for Monitor {
        fn drop(&mut self) {
            // The token comes from this process's local monitor registration.
            unsafe { NSEvent::removeMonitor(&self.token) };
        }
    }
    thread_local! {
        static MONITOR: RefCell<Option<Monitor>> = const { RefCell::new(None) };
    }

    pub fn remove_view(label: &str) {
        MONITOR.with_borrow_mut(|monitor| {
            if let Some(monitor) = monitor {
                monitor.views.remove(label);
            }
        });
    }

    pub fn shutdown() {
        MONITOR.with_borrow_mut(|monitor| *monitor = None);
    }

    pub fn register(manager: PreviewManager, view: &Webview) -> Result<()> {
        let label = view.label().to_owned();
        view.with_webview(move |platform| {
            // Tauri invokes this callback on the main thread and lends its WKWebView.
            let Some(native) = (unsafe { Retained::retain(platform.inner().cast::<WKWebView>()) })
            else {
                return;
            };
            MONITOR.with_borrow_mut(|monitor| {
                if monitor.is_none() {
                    let handler = block2::RcBlock::new(move |event: NonNull<NSEvent>| {
                        if relay(&manager, event) {
                            std::ptr::null_mut()
                        } else {
                            event.as_ptr()
                        }
                    });
                    // Passing the original event or null follows the AppKit monitor contract.
                    let token = unsafe {
                        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                            NSEventMask::KeyDown,
                            &handler,
                        )
                    };
                    *monitor = token.map(|token| Monitor {
                        token,
                        views: HashMap::new(),
                    });
                }
                if let Some(monitor) = monitor {
                    monitor.views.insert(label, native);
                }
            });
        })
        .map_err(|error| error.to_string())
    }

    fn relay(manager: &PreviewManager, event: NonNull<NSEvent>) -> bool {
        // AppKit supplies a live event for the duration of this main-thread callback.
        let event = unsafe { event.as_ref() };
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        if event.isARepeat() {
            return false;
        }
        let Some((label, scope)) = manager.visible_label() else {
            return false;
        };
        let native = MONITOR.with_borrow(|monitor| monitor.as_ref()?.views.get(&label).cloned());
        let Some(native) = native else { return false };
        if native.isHiddenOrHasHiddenAncestor() {
            return false;
        }
        let Some(window) = event.window(mtm) else {
            return false;
        };
        let Some(child_window) = native.window() else {
            return false;
        };
        let Some(main) = manager.0.app.get_window("main") else {
            return false;
        };
        let Ok(main_pointer) = main.ns_window() else {
            return false;
        };
        let window_pointer: *const objc2_app_kit::NSWindow = &*window;
        if !window.isKeyWindow()
            || !std::ptr::eq(&*window, &*child_window)
            || window_pointer.cast::<std::ffi::c_void>() != main_pointer.cast_const()
        {
            return false;
        }
        let Some(first) = window.firstResponder() else {
            return false;
        };
        if !first
            .downcast_ref::<NSView>()
            .is_some_and(|view| view.isDescendantOf(&native))
        {
            return false;
        }
        let flags = event.modifierFlags();
        let characters = if event.respondsToSelector(sel!(charactersByApplyingModifiers:)) {
            event.charactersByApplyingModifiers(
                flags & !(NSEventModifierFlags::Control | NSEventModifierFlags::Command),
            )
        } else if flags.contains(NSEventModifierFlags::Option) {
            if flags.contains(NSEventModifierFlags::Control) {
                return false;
            }
            event.characters()
        } else {
            event.charactersIgnoringModifiers()
        };
        let Some(key) =
            characters.and_then(|text| normalize_key(&text.to_string(), event.keyCode()))
        else {
            return false;
        };
        let physical = physical_key(event.keyCode());
        let shortcut = Shortcut {
            key: key.clone(),
            meta_key: flags.contains(NSEventModifierFlags::Command),
            ctrl_key: flags.contains(NSEventModifierFlags::Control),
            alt_key: flags.contains(NSEventModifierFlags::Option),
            shift_key: flags.contains(NSEventModifierFlags::Shift),
        };
        let latin = key.len() == 1 && key.as_bytes()[0].is_ascii_lowercase();
        let matches = manager.0.shortcuts.lock().ok().is_some_and(|shortcuts| {
            shortcuts.iter().any(|allowed| {
                allowed.meta_key == shortcut.meta_key
                    && allowed.ctrl_key == shortcut.ctrl_key
                    && allowed.alt_key == shortcut.alt_key
                    && allowed.shift_key == shortcut.shift_key
                    && (allowed.key == key
                        || (!latin && physical.is_some_and(|key| allowed.key == key)))
            })
        });
        #[derive(Clone, serde::Serialize)]
        struct Event {
            #[serde(flatten)]
            shortcut: Shortcut,
            code: String,
            scope: super::super::PreviewScope,
        }
        let code = match physical {
            Some(key) if key.len() == 1 && key.as_bytes()[0].is_ascii_lowercase() => {
                format!("Key{}", key.to_uppercase())
            }
            Some(key) if key.len() == 1 && key.as_bytes()[0].is_ascii_digit() => {
                format!("Digit{key}")
            }
            Some("`") => "Backquote".into(),
            Some("\\") => "Backslash".into(),
            Some("[") => "BracketLeft".into(),
            Some("]") => "BracketRight".into(),
            Some(",") => "Comma".into(),
            Some("=") => "Equal".into(),
            Some("-") => "Minus".into(),
            Some(".") => "Period".into(),
            Some("'") => "Quote".into(),
            Some(";") => "Semicolon".into(),
            Some("/") => "Slash".into(),
            _ => String::new(),
        };
        matches
            && manager
                .0
                .app
                .emit_to(
                    EventTarget::webview("main"),
                    "botcode-preview-shortcut",
                    Event {
                        shortcut,
                        code,
                        scope,
                    },
                )
                .is_ok()
    }

    fn normalize_key(characters: &str, code: u16) -> Option<String> {
        let key = characters.to_lowercase();
        if key.is_empty()
            || key
                .chars()
                .any(|key| key.is_control() || ('\u{f700}'..='\u{f8ff}').contains(&key))
        {
            physical_key(code).map(str::to_owned)
        } else {
            Some(key)
        }
    }

    fn physical_key(code: u16) -> Option<&'static str> {
        Some(match code {
            0 => "a",
            1 => "s",
            2 => "d",
            3 => "f",
            4 => "h",
            5 => "g",
            6 => "z",
            7 => "x",
            8 => "c",
            9 => "v",
            11 => "b",
            12 => "q",
            13 => "w",
            14 => "e",
            15 => "r",
            16 => "y",
            17 => "t",
            18 => "1",
            19 => "2",
            20 => "3",
            21 => "4",
            22 => "6",
            23 => "5",
            24 => "=",
            25 => "9",
            26 => "7",
            27 => "-",
            28 => "8",
            29 => "0",
            30 => "]",
            31 => "o",
            32 => "u",
            33 => "[",
            34 => "i",
            35 => "p",
            36 => "enter",
            37 => "l",
            38 => "j",
            39 => "'",
            40 => "k",
            41 => ";",
            42 => "\\",
            43 => ",",
            44 => "/",
            45 => "n",
            46 => "m",
            47 => ".",
            48 => "tab",
            49 => " ",
            50 => "`",
            51 => "backspace",
            53 => "escape",
            64 => "f17",
            76 => "enter",
            79 => "f18",
            80 => "f19",
            90 => "f20",
            96 => "f5",
            97 => "f6",
            98 => "f7",
            99 => "f3",
            100 => "f8",
            101 => "f9",
            103 => "f11",
            105 => "f13",
            106 => "f16",
            107 => "f14",
            109 => "f10",
            111 => "f12",
            113 => "f15",
            115 => "home",
            116 => "pageup",
            117 => "delete",
            118 => "f4",
            119 => "end",
            120 => "f2",
            121 => "pagedown",
            122 => "f1",
            123 => "arrowleft",
            124 => "arrowright",
            125 => "arrowdown",
            126 => "arrowup",
            _ => return None,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::normalize_key;

        #[test]
        fn normalizes_native_keypad_enter_and_extended_function_keys() {
            assert_eq!(normalize_key("\u{3}", 76).as_deref(), Some("enter"));
            for (code, key) in [
                (105, "f13"),
                (107, "f14"),
                (113, "f15"),
                (106, "f16"),
                (64, "f17"),
                (79, "f18"),
                (80, "f19"),
                (90, "f20"),
            ] {
                assert_eq!(normalize_key("\u{f710}", code).as_deref(), Some(key));
            }
        }

        #[test]
        fn preserves_option_text_and_uses_the_keycode_for_dead_keys() {
            assert_eq!(normalize_key("ø", 1).as_deref(), Some("ø"));
            assert_eq!(normalize_key("", 14).as_deref(), Some("e"));
            assert_eq!(normalize_key("\u{10}", 255), None);
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::{register, remove_view, shutdown};
#[cfg(not(target_os = "macos"))]
pub fn register(_: PreviewManager, _: &tauri::Webview) -> Result<()> {
    Ok(())
}
#[cfg(not(target_os = "macos"))]
pub fn remove_view(_: &str) {}
#[cfg(not(target_os = "macos"))]
pub fn shutdown() {}
