// Ported from T3 Code v0.0.45 desktop/permissions/MacPermission.ts and MacPermissions.ts (MIT).
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    ScreenRecording,
    Accessibility,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    screen_recording: bool,
    accessibility: bool,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn l1_permission_granted(permission: i32) -> bool;
    fn l1_permission_open(permission: i32, owner: *mut std::ffi::c_void) -> i32;
}

#[tauri::command]
pub fn mac_permission_status() -> Result<PermissionStatus, String> {
    #[cfg(target_os = "macos")]
    unsafe {
        Ok(PermissionStatus {
            screen_recording: l1_permission_granted(0),
            accessibility: l1_permission_granted(1),
        })
    }
    #[cfg(not(target_os = "macos"))]
    Err("macOS permissions are unavailable on this platform.".into())
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsOpened {
    #[cfg(target_os = "macos")]
    Helper,
    #[cfg(target_os = "macos")]
    Unpackaged,
}

#[tauri::command]
pub async fn mac_permission_open(
    window: tauri::WebviewWindow,
    permission: Permission,
) -> Result<SettingsOpened, String> {
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        let owner = window.clone();
        window
            .run_on_main_thread(move || {
                let result = owner
                    .ns_window()
                    .map_err(|error| error.to_string())
                    .and_then(|pointer| {
                        let permission = match permission {
                            Permission::ScreenRecording => 0,
                            Permission::Accessibility => 1,
                        };
                        match unsafe { l1_permission_open(permission, pointer) } {
                            0 => Ok(SettingsOpened::Unpackaged),
                            1 => Ok(SettingsOpened::Helper),
                            _ => Err("Could not open System Settings. Try again.".into()),
                        }
                    });
                let _ = send.send(result);
            })
            .map_err(|error| error.to_string())?;
        receive.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, permission);
        Err("macOS permissions are unavailable on this platform.".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[repr(C)]
    #[derive(Debug, PartialEq)]
    struct Frame {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }
    unsafe extern "C" {
        fn l1_helper_frame(x: f64, y: f64, width: f64, height: f64, primary_top: f64) -> Frame;
        fn l1_helper_action(
            owner: bool,
            granted: bool,
            tracking: bool,
            found: bool,
            settings: bool,
            frontmost: bool,
            focused: bool,
        ) -> i32;
    }
    #[test]
    fn fixed_permission_domain_rejects_arbitrary_settings_urls() {
        assert!(serde_json::from_str::<Permission>("\"screen-recording\"").is_ok());
        assert!(serde_json::from_str::<Permission>("\"accessibility\"").is_ok());
        assert!(serde_json::from_str::<Permission>("\"full-disk-access\"").is_err());
        assert!(serde_json::from_str::<Permission>("\"https://example.com\"").is_err());
        assert_eq!(
            serde_json::to_value(PermissionStatus {
                screen_recording: false,
                accessibility: true
            })
            .unwrap(),
            serde_json::json!({"screenRecording": false, "accessibility": true})
        );
    }
    #[test]
    fn helper_follows_settings_and_converts_secondary_display_coordinates() {
        unsafe {
            assert_eq!(
                l1_helper_frame(100., 100., 800., 600., 1080.),
                Frame {
                    x: 332.,
                    y: 396.,
                    width: 552.,
                    height: 140.
                }
            );
            assert_eq!(
                l1_helper_frame(-1400., -900., 1000., 700., 1080.),
                Frame {
                    x: -1072.,
                    y: 1296.,
                    width: 560.,
                    height: 140.
                }
            );
        }
    }
    #[test]
    fn helper_hides_returns_or_disposes_from_observed_lifecycle() {
        unsafe {
            assert_eq!(
                l1_helper_action(true, false, true, false, false, false, false),
                0
            );
            assert_eq!(
                l1_helper_action(true, false, true, true, true, true, false),
                1
            );
            assert_eq!(
                l1_helper_action(true, false, true, true, true, false, true),
                1
            );
            assert_eq!(
                l1_helper_action(true, false, true, true, true, false, false),
                0
            );
            assert_eq!(
                l1_helper_action(true, false, false, true, false, false, false),
                0
            );
            assert_eq!(
                l1_helper_action(true, false, true, true, false, false, false),
                2
            );
            assert_eq!(
                l1_helper_action(true, true, false, false, false, false, false),
                2
            );
            assert_eq!(
                l1_helper_action(false, true, true, true, true, true, true),
                3
            );
        }
    }
}
