use bot_core::App;
use tauri::{
    Manager, UriSchemeContext, UriSchemeResponder, Wry,
    http::{Method, Request, Response, header},
};

pub fn handle(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let status = |code: u16| {
        Response::builder()
            .status(code)
            .body(Vec::new())
            .expect("static response parts are valid")
    };
    if ctx.webview_label() != "main" {
        return responder.respond(status(404));
    }
    if request.method() != Method::GET {
        return responder.respond(status(405));
    }
    let app = ctx.app_handle().state::<App>().inner().clone();
    let path = request.uri().path().to_owned();
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let if_range = request.headers().contains_key(header::IF_RANGE);
    tauri::async_runtime::spawn(async move {
        let file = app
            .serve_workspace_file(&path, range.as_deref(), if_range)
            .await;
        let mut response = Response::builder().status(file.status);
        for (name, value) in file.headers {
            response = response.header(name, value);
        }
        responder.respond(response.body(file.body).unwrap_or_else(|_| status(500)));
    });
}
