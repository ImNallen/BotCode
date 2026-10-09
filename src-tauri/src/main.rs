#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(target_os = "macos")]
mod edit_history;
mod filesystem;
mod ipc;
mod notifications;
mod preview;
mod workspace_files;
use bot_core::{AgentTools, App, Registration, RuntimeConfig};
use tauri::{Emitter, EventTarget, Manager};
fn main() {
    if std::env::args().any(|argument| argument == "--agent-tools") {
        if let Err(error) = tauri::async_runtime::block_on(bot_core::run_agent_tools_stdio()) {
            eprintln!("{}", error.message);
            std::process::exit(1);
        }
        return;
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(edit_history::menu)
        .on_menu_event(edit_history::on_menu_event);
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(notifications::NotificationActions::default())
        .register_asynchronous_uri_scheme_protocol(
            "botcode-attachment",
            |ctx, request, responder| {
                if ctx.webview_label() != "main" {
                    responder.respond(
                        tauri::http::Response::builder()
                            .status(404)
                            .body(Vec::new())
                            .expect("static response parts are valid"),
                    );
                    return;
                }
                let app = ctx.app_handle().state::<App>().inner().clone();
                let file = request.uri().path().trim_start_matches('/').to_owned();
                tauri::async_runtime::spawn_blocking(move || {
                    let response = match app.read_attachment(&file) {
                        Ok((bytes, mime)) => tauri::http::Response::builder()
                            .header("Content-Type", mime.as_str())
                            .header("Cache-Control", "private, max-age=31536000, immutable")
                            .body(bytes),
                        Err(_) => tauri::http::Response::builder()
                            .status(404)
                            .body(Vec::new()),
                    };
                    responder.respond(response.expect("static response parts are valid"));
                });
            },
        )
        .register_asynchronous_uri_scheme_protocol(
            bot_core::workspace_files::SCHEME,
            workspace_files::handle,
        )
        .setup(|app| {
            notifications::install(app.handle());
            let config = RuntimeConfig::from_environment()?;
            let preview = preview::PreviewManager::new(app.handle().clone());
            let backend =
                preview::tools::PreviewTools::new(preview.clone(), config.data_dir.clone());
            app.manage(preview);
            let runtime = tauri::async_runtime::block_on(App::open_with_tools(
                config,
                AgentTools {
                    registration: Registration::Stdio {
                        executable: std::env::current_exe()?,
                    },
                    backend: Some(std::sync::Arc::new(backend)),
                },
            ))?;
            let mut changes = runtime.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match changes.recv().await {
                        Ok(change) => {
                            let _ =
                                handle.emit_to(EventTarget::webview("main"), "bot:changed", change);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ = handle.emit_to(EventTarget::webview("main"), "bot:refresh", ());
                        }
                        Err(_) => break,
                    }
                }
            });
            let mut limits = runtime.watch_usage_limits();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while limits.changed().await.is_ok() {
                    let value = limits.borrow_and_update().clone();
                    if let Some(value) = value {
                        let _ =
                            handle.emit_to(EventTarget::webview("main"), "bot:usage-limits", value);
                    }
                }
            });
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler({
            let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                ipc::search_thread_messages,
                preview::preview_state,
                preview::preview_open,
                preview::preview_navigate,
                preview::preview_viewport,
                preview::preview_attach,
                preview::preview_layout,
                preview::preview_detach,
                preview::preview_discover,
                preview::preview_application_shortcuts,
                notifications::notification_actions,
                ipc::project_config,
                ipc::retry_worktree_setup,
                ipc::run_project_script,
                ipc::list_workspaces,
                ipc::open_workspace,
                filesystem::browse_directory,
                ipc::rename_workspace,
                ipc::remove_workspace,
                ipc::scratch_available,
                ipc::ensure_scratch,
                ipc::workspace_view,
                ipc::search_paths,
                ipc::search_contents,
                ipc::cancel_project_search,
                ipc::read_file,
                ipc::write_file,
                ipc::read_diff,
                ipc::read_turn_diff,
                ipc::revert_thread,
                ipc::list_branches,
                ipc::list_worktrees,
                ipc::prepare_pull_request_thread,
                ipc::switch_branch,
                ipc::git_status,
                ipc::current_branch_pull_request,
                ipc::search_composer_pull_requests,
                ipc::list_thread_pull_requests,
                ipc::link_pull_request,
                ipc::unlink_pull_request,
                ipc::read_pull_request,
                ipc::read_pull_request_commit_files,
                ipc::read_pull_request_file_contents,
                ipc::read_pull_request_files_viewed,
                ipc::set_pull_request_files_viewed,
                ipc::change_pull_request,
                ipc::reconcile_pull_request,
                ipc::acknowledge_uncertain_update,
                ipc::pull_request_operations,
                ipc::set_review_disposition,
                ipc::run_git_action,
                ipc::begin_commit_message,
                ipc::await_commit_message,
                ipc::cancel_commit_message,
                ipc::open_url,
                ipc::available_editors,
                ipc::open_in_editor,
                ipc::reveal_in_finder,
                ipc::create_thread,
                ipc::thread_snapshot,
                ipc::open_thread,
                ipc::stage_attachment,
                ipc::submit,
                ipc::list_models,
                ipc::provider_capabilities,
                ipc::list_skills,
                ipc::collaboration_modes,
                ipc::answer_user_questions,
                ipc::usage_limits,
                ipc::usage_history,
                ipc::update_thread_settings,
                ipc::answer_approval,
                ipc::interrupt,
                ipc::arrange_thread,
                ipc::rename_thread,
                ipc::delete_thread,
                ipc::list_thread_summaries,
                ipc::ui_state,
                ipc::set_ui_state,
                ipc::clipboard_text,
                ipc::settings,
                ipc::keybindings_file,
                ipc::save_keybindings_file,
                ipc::save_settings,
                ipc::terminal_attach,
                ipc::terminal_detach,
                ipc::terminal_write,
                ipc::terminal_resize,
                ipc::terminal_close
            ];
            move |invoke| {
                if invoke.message.webview_ref().label() != "main" {
                    invoke
                        .resolver
                        .reject("Application commands require the main webview.");
                    return true;
                }
                commands(invoke)
            }
        })
        .build(tauri::generate_context!())
        .expect("Bot Code could not start");
    app.run(|handle, event| {
        if matches!(&event, tauri::RunEvent::Exit)
            || matches!(&event, tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == "main")
        {
            preview::shutdown_keyboard();
        }
        if matches!(event, tauri::RunEvent::Exit) {
            let runtime = handle.state::<App>();
            let _ = tauri::async_runtime::block_on(runtime.shutdown());
        }
    });
}
