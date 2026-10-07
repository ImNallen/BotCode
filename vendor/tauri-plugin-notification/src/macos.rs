// Bot Code macOS backend patch for tauri-plugin-notification 2.3.3 (MIT OR Apache-2.0).
use crate::{Error, NotificationBuilder, NotificationData, Result};
use block2::RcBlock;
use futures_channel::oneshot;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{
    ns_string, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::{ptr::NonNull, sync::Mutex};
use tauri::{
    plugin::{PermissionState, PluginApi},
    AppHandle, Emitter, Runtime,
};

type Action = Box<dyn Fn(NotificationData) + Send + Sync>;
struct DelegateIvars {
    action: Mutex<Option<Action>>,
}

define_class!(
    #[unsafe(super = NSObject)]
    #[ivars = DelegateIvars]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::empty(),));
        }
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            let payload = response
                .notification()
                .request()
                .content()
                .userInfo()
                .objectForKey(ns_string!("tauriNotification"))
                .and_then(|value| value.downcast::<NSString>().ok())
                .and_then(|value| {
                    serde_json::from_str::<NotificationData>(&value.to_string()).ok()
                });
            let is_click = response.actionIdentifier().to_string()
                == "com.apple.UNNotificationDefaultActionIdentifier";
            completion.call(());
            if is_click {
                if let Some(payload) = payload {
                    if let Ok(handler) = self.ivars().action.lock() {
                        if let Some(handler) = handler.as_ref() {
                            handler(payload);
                        }
                    }
                }
            }
        }
    }
);
// UserNotifications calls delegates on its own queue. The only Rust ivar is a
// mutex-protected Send + Sync callback; no thread-bound Cocoa object is stored.
unsafe impl Send for Delegate {}
unsafe impl Sync for Delegate {}

pub struct Notification<R: Runtime> {
    app: AppHandle<R>,
    delegate: Option<Retained<Delegate>>,
}

fn bundled() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}
fn center() -> Result<Retained<UNUserNotificationCenter>> {
    if !bundled() {
        return Err(Error::Native("Notifications require launching the bundled Bot Code.app. Sound only is still available.".into()));
    }
    Ok(UNUserNotificationCenter::currentNotificationCenter())
}
fn error(error: *mut NSError) -> Result<()> {
    if error.is_null() {
        Ok(())
    } else {
        Err(Error::Native(
            unsafe { &*error }.localizedDescription().to_string(),
        ))
    }
}
fn permission(status: UNAuthorizationStatus) -> PermissionState {
    match status {
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral => PermissionState::Granted,
        UNAuthorizationStatus::Denied => PermissionState::Denied,
        _ => PermissionState::Prompt,
    }
}
pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<Notification<R>> {
    let delegate = if bundled() {
        let allocated = Delegate::alloc().set_ivars(DelegateIvars {
            action: Mutex::new(None),
        });
        let delegate: Retained<Delegate> = unsafe { msg_send![super(allocated), init] };
        center()?.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        Some(delegate)
    } else {
        None
    };
    Ok(Notification {
        app: app.clone(),
        delegate,
    })
}
impl<R: Runtime> Notification<R> {
    pub fn builder(&self) -> NotificationBuilder<R> {
        NotificationBuilder::new(self.app.clone())
    }
    pub fn on_action(&self, handler: impl Fn(NotificationData) + Send + Sync + 'static) {
        if let Some(delegate) = &self.delegate {
            *delegate
                .ivars()
                .action
                .lock()
                .expect("notification action lock") = Some(Box::new(handler));
        }
    }
    pub async fn permission_state_async(&self) -> Result<PermissionState> {
        let receiver = begin_permission_state()?;
        receiver
            .await
            .map_err(|_| Error::Native("Notification settings callback was lost.".into()))
    }
    pub async fn request_permission_async(&self) -> Result<PermissionState> {
        let receiver = begin_request_permission()?;
        receiver
            .await
            .map_err(|_| Error::Native("Notification permission callback was lost.".into()))?
    }
    pub fn permission_state(&self) -> Result<PermissionState> {
        if objc2::MainThreadMarker::new().is_some() {
            return Err(Error::Native(
                "Use permission_state_async on the main thread.".into(),
            ));
        }
        tauri::async_runtime::block_on(self.permission_state_async())
    }
    pub fn request_permission(&self) -> Result<PermissionState> {
        if objc2::MainThreadMarker::new().is_some() {
            return Err(Error::Native(
                "Use request_permission_async on the main thread.".into(),
            ));
        }
        tauri::async_runtime::block_on(self.request_permission_async())
    }
}
fn begin_permission_state() -> Result<oneshot::Receiver<PermissionState>> {
    let center = center()?;
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let state = permission(unsafe { settings.as_ref() }.authorizationStatus());
        if let Some(sender) = sender.lock().unwrap().take() {
            let _ = sender.send(state);
        }
    });
    center.getNotificationSettingsWithCompletionHandler(&block);
    Ok(receiver)
}
fn begin_request_permission() -> Result<oneshot::Receiver<Result<PermissionState>>> {
    let center = center()?;
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    let block = RcBlock::new(move |granted: Bool, native_error: *mut NSError| {
        let result = error(native_error).map(|()| {
            if granted.as_bool() {
                PermissionState::Granted
            } else {
                PermissionState::Denied
            }
        });
        if let Some(sender) = sender.lock().unwrap().take() {
            let _ = sender.send(result);
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &block);
    Ok(receiver)
}
impl<R: Runtime> NotificationBuilder<R> {
    pub async fn show_async(self) -> Result<()> {
        if self.app.notification().permission_state_async().await? != PermissionState::Granted {
            return Err(Error::Native(
                "Notifications are not authorized in System Settings.".into(),
            ));
        }
        let receiver = begin_show(self.data)?;
        receiver
            .await
            .map_err(|_| Error::Native("Notification delivery callback was lost.".into()))?
    }
    pub fn show(self) -> Result<()> {
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = self.show_async().await {
                let _ = app.emit("notification:delivery-error", error.to_string());
            }
        });
        Ok(())
    }
}
use crate::NotificationExt;

fn begin_show(data: NotificationData) -> Result<oneshot::Receiver<Result<()>>> {
    let center = center()?;
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(
        data.title.as_deref().unwrap_or("Bot Code"),
    ));
    content.setBody(&NSString::from_str(data.body.as_deref().unwrap_or("")));
    content.setSound(None);
    let serialized = serde_json::to_string(&data).map_err(|e| Error::Native(e.to_string()))?;
    let value = NSString::from_str(&serialized);
    let typed_info = NSDictionary::from_slices(&[ns_string!("tauriNotification")], &[&*value]);
    // NSDictionary generics describe its existing objects; both are NSObject subclasses.
    let info: Retained<NSDictionary> = unsafe { Retained::cast_unchecked(typed_info) };
    unsafe { content.setUserInfo(&info) };
    let identifier = NSString::from_str(data.group.as_deref().unwrap_or(&data.id.to_string()));
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    let block = RcBlock::new(move |native_error: *mut NSError| {
        if let Some(sender) = sender.lock().unwrap().take() {
            let _ = sender.send(error(native_error));
        }
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&block));
    Ok(receiver)
}
