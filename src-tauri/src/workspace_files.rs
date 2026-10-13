use l1_core::{App, workspace_files::FileResponse};
use tauri::{
    Manager, UriSchemeContext, UriSchemeResponder, Wry,
    http::{Method, Request, Response, header},
};

fn status(code: u16) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .body(Vec::new())
        .expect("static response parts are valid")
}

fn into_response(file: FileResponse) -> Response<Vec<u8>> {
    let mut response = Response::builder().status(file.status);
    for (name, value) in file.headers {
        response = response.header(name, value);
    }
    response.body(file.body).unwrap_or_else(|_| status(500))
}

fn range(request: &Request<Vec<u8>>) -> (Option<String>, bool) {
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    (range, request.headers().contains_key(header::IF_RANGE))
}

pub fn handle(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if ctx.webview_label() != "main" {
        return responder.respond(status(404));
    }
    if request.method() != Method::GET {
        return responder.respond(status(405));
    }
    let app = ctx.app_handle().state::<App>().inner().clone();
    let path = request.uri().path().to_owned();
    let (range, if_range) = range(&request);
    tauri::async_runtime::spawn(async move {
        let file = app
            .serve_workspace_file(&path, range.as_deref(), if_range)
            .await;
        responder.respond(into_response(file));
    });
}

pub fn handle_attachment(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if ctx.webview_label() != "main" {
        return responder.respond(status(404));
    }
    let app = ctx.app_handle().state::<App>().inner().clone();
    let file = request.uri().path().trim_start_matches('/').to_owned();
    let (range, if_range) = range(&request);
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(into_response(app.serve_attachment(
            &file,
            range.as_deref(),
            if_range,
        )));
    });
}
