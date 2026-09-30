//! Tauri commands reuse the existing native human/session/signer boundary.
use super::*;

#[tauri::command]
pub(crate) async fn spaces_query_work_consent_intents<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
    operations: tauri::State<'_, SpacesWorkConsent>,
    input: ThreadInput,
) -> Result<CommandResult, String> {
    commands::command(
        &app,
        &auth,
        &community,
        &state,
        &operations,
        Action::IntentQuery(&input),
    )
    .await
}

#[tauri::command]
pub(crate) async fn spaces_read_work_consent_intent<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
    operations: tauri::State<'_, SpacesWorkConsent>,
    input: IntentReadInput,
) -> Result<CommandResult, String> {
    commands::command(
        &app,
        &auth,
        &community,
        &state,
        &operations,
        Action::IntentRead(&input),
    )
    .await
}

#[tauri::command]
pub(crate) async fn spaces_select_work_consent_account<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
    operations: tauri::State<'_, SpacesWorkConsent>,
    input: SelectInput,
) -> Result<CommandResult, String> {
    commands::command(
        &app,
        &auth,
        &community,
        &state,
        &operations,
        Action::Select(&input),
    )
    .await
}
