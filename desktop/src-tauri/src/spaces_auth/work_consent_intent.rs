//! Owner-only account selection prepares a consent review. It neither decides
//! access nor starts work. Frozen requests and current bindings remain Gateway-owned.
use super::*;
use std::collections::BTreeMap;

fn validate_intent(value: &Intent, expected: &native_scope::Scope) -> Result<(), Failure> {
    let t = &value.terms;
    if t.org_id != expected.config.org_id {
        return Err(Failure::AccessLost);
    }
    if !identifier(&value.id)
        || !version(value.version)
        || !digest(&value.digest)
        || [&t.org_id, &t.application_id, &t.workload_identity_id]
            .iter()
            .any(|v| !identifier(v))
        || t.task_summary.is_empty()
        || t.task_summary.len() > 512
    {
        return Err(Failure::Invalid);
    }
    validate_task(&t.task, &t.audience)?;
    validate_scope(&t.scope)?;
    validate_duration(&value.created_at, &t.expires_at)
}
// Compare every shared frozen term, including the original requester and scope
// mechanics. Work ID alone cannot establish the reviewed request.
pub(super) fn linked(
    consent: &Record,
    intent: &Intent,
    expected: &native_scope::Scope,
) -> Result<(), Failure> {
    validate_record(consent, expected)?;
    let c = &consent.terms;
    let t = &intent.terms;
    if c.org_id != t.org_id
        || c.application_id != t.application_id
        || c.workload_identity_id != t.workload_identity_id
        || c.task != t.task
        || c.task_summary != t.task_summary
        || c.scope != t.scope
        || c.audience != t.audience
        || c.expires_at != t.expires_at
    {
        return Err(Failure::Invalid);
    }
    Ok(())
}
pub(super) fn validate_owner(
    value: &OwnerResult,
    expected: &native_scope::Scope,
) -> Result<(), Failure> {
    validate_intent(&value.intent, expected)?;
    if value.accounts.len() > 1 {
        return Err(Failure::Invalid);
    }
    for a in &value.accounts {
        if !identifier(&a.account_id)
            || !version(a.account_version)
            || !identifier(&a.connection_id)
            || a.provider != "granola"
            || a.label
                .as_ref()
                .is_some_and(|v| display::label(v, 256).is_none())
            || a.email
                .as_ref()
                .is_some_and(|v| display::label(v, 320).is_none())
        {
            return Err(Failure::Invalid);
        }
    }
    if let Some(consent) = &value.consent {
        linked(consent, &value.intent, expected)?;
    }
    Ok(())
}
pub(super) async fn query(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    input: &ThreadInput,
) -> Result<IntentLookup, Failure> {
    let lookup: IntentLookup = response(
        client
            .post(format!("{gateway}/v1/space/work-consents/intents/query"))
            .bearer_auth(&session.access_token)
            .json(&lookup_body(expected, input)?),
    )
    .await?;
    if !identifier(&lookup.work_id) || lookup.intents.len() > REQUEST_LIMIT {
        return Err(Failure::Invalid);
    }
    // Gateway may filter newly stale rows after computing the cursor; the last
    // returned item need not be the cursor. This cursor belongs only to intents.
    if lookup
        .next
        .as_ref()
        .is_some_and(|v| !timestamp(&v.created_at) || !identifier(&v.id))
    {
        return Err(Failure::Invalid);
    }
    let mut seen = std::collections::HashSet::new();
    for intent in &lookup.intents {
        validate_intent(intent, expected)?;
        if intent.terms.task.work_id != lookup.work_id || !seen.insert(&intent.id) {
            return Err(Failure::Invalid);
        }
    }
    Ok(lookup)
}
pub(super) async fn read(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    input: &IntentReadInput,
    current: &impl Fn() -> Result<(), Failure>,
) -> Result<OwnerResult, Failure> {
    let lookup = query(client, session, gateway, expected, &input.thread).await?;
    current()?;
    let result: OwnerResult = response(
        client
            .get(format!(
                "{gateway}/v1/space/work-consents/intents/{}",
                input.intent_id
            ))
            .bearer_auth(&session.access_token),
    )
    .await?;
    current()?;
    validate_owner(&result, expected)?;
    // A bound/expired intent is intentionally absent from unbound query pages.
    // Resolve the exact native origin freshly, then use Gateway's owner GET.
    if result.intent.id != input.intent_id || result.intent.terms.task.work_id != lookup.work_id {
        return Err(Failure::AccessLost);
    }
    if lookup
        .intents
        .iter()
        .find(|v| v.id == input.intent_id)
        .is_some_and(|v| v.terms != result.intent.terms || v.digest != result.intent.digest)
    {
        return Err(Failure::Conflict);
    }
    if input
        .expected_consent_id
        .as_ref()
        .is_some_and(|id| !result.consent.as_ref().is_some_and(|c| &c.id == id))
    {
        return Err(Failure::Conflict);
    }
    Ok(result)
}
pub(super) async fn select(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    input: &SelectInput,
    operations: &SpacesWorkConsent,
    current: &impl Fn() -> Result<(), Failure>,
) -> Result<Record, Failure> {
    let owner = read(client, session, gateway, expected, &input.read, current).await?;
    current()?;
    let intent = &owner.intent;
    if let Some(consent) = &owner.consent {
        // Never bind a replacement or describe its historical selection as new.
        return if consent.terms.account_id == input.selection.account_id
            && consent.terms.account_version == input.selection.account_version
            && intent.digest == input.selection.intent_digest
            && intent.version == input.selection.expected_version
        {
            Ok(consent.clone())
        } else {
            Err(Failure::Conflict)
        };
    }
    // Selection is a separate deliberate write, so remote identity/config must
    // still match after the owner-only account read.
    verify_session(client, session, gateway, expected, current).await?;
    let eligible = intent.state == IntentState::SelectAccount
        && intent.version == input.selection.expected_version
        && intent.digest == input.selection.intent_digest
        && chrono::DateTime::parse_from_rfc3339(&intent.terms.expires_at)
            .is_ok_and(|v| v > chrono::Utc::now())
        && owner.accounts.iter().any(|a| {
            a.account_id == input.selection.account_id
                && a.account_version == input.selection.account_version
        });
    // Unknown writes retain their original body even after rotation or expiry.
    // A fresh selection must match current choices. Gateway settles replays.
    let selection = operations.reserve_selection(
        expected,
        &input.read.thread,
        &intent.terms.task.work_id,
        &intent.id,
        &input.selection,
        eligible,
    )?;
    current()?;
    let result: Result<Record, Failure> = response(
        client
            .post(format!(
                "{gateway}/v1/space/work-consents/intents/{}/select",
                intent.id
            ))
            .bearer_auth(&session.access_token)
            .json(&selection),
    )
    .await
    .map_err(|f| match f {
        Failure::Invalid | Failure::Unavailable => Failure::Uncertain,
        value => value,
    });
    current()?;
    if matches!(result, Err(Failure::Conflict)) {
        operations.reject_selection(expected, &intent.id, &selection.operation_id)?;
    }
    let consent = result?;
    linked(&consent, intent, expected).map_err(|f| {
        if f == Failure::AccessLost {
            f
        } else {
            Failure::Uncertain
        }
    })?;
    if consent.terms.account_id != selection.account_id
        || consent.terms.account_version != selection.account_version
    {
        return Err(Failure::Uncertain);
    }
    Ok(consent)
}

pub(super) fn intent_displays(
    directory: &display::Directory,
    intents: &[&Intent],
) -> BTreeMap<String, display::Display> {
    intents
        .iter()
        .map(|i| {
            (
                i.id.clone(),
                display::task_display(directory, &i.terms.task),
            )
        })
        .collect()
}
pub(super) fn bound_display(
    directory: &display::Directory,
    owner: &OwnerResult,
) -> BTreeMap<String, display::Display> {
    let mut displays = BTreeMap::new();
    if let Some(c) = &owner.consent {
        let mut hint = display::task_display(directory, &c.terms.task);
        if let Some(a) = owner.accounts.iter().find(|a| {
            a.account_id == c.terms.account_id
                && a.account_version == c.terms.account_version
                && a.connection_id == c.terms.connection_id
                && a.provider == c.terms.provider
        }) {
            hint.account_label = a.label.clone();
            hint.account_email = a.email.clone();
        }
        displays.insert(c.id.clone(), hint);
    }
    displays
}
