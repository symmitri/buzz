//! Ephemeral selected-preview cache and exact uncertain native decisions.
//! This is bounded view state, not candidate storage. Fresh Gateway authority is
//! required on every restore; hiding a view never resubmits a decision.
use super::*;
use std::{collections::BTreeMap, sync::Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct SpacesWorkRelease(Mutex<State>);
struct Cached {
    body: Zeroizing<String>,
    expires_at: chrono::DateTime<chrono::FixedOffset>,
}
#[derive(Default)]
struct State {
    next: u64,
    revision: u64,
    views: BTreeMap<String, (u64, CancellationToken)>,
    scope: Option<(u64, String)>,
    pending: BTreeMap<String, DecisionInput>,
    previews: BTreeMap<String, Cached>,
}
impl State {
    fn scope(&mut self, expected: &native_scope::Scope) -> Result<(), Failure> {
        let token = scope_token(expected);
        if let Some((generation, current)) = &self.scope {
            if *generation > expected.generation
                || (*generation == expected.generation && current != &token)
            {
                return Err(Failure::AccessLost);
            }
            if *generation == expected.generation {
                self.prune();
                return Ok(());
            }
        }
        self.revision = self.revision.wrapping_add(1);
        self.pending.clear();
        self.previews.clear();
        for (_, cancel) in self.views.values() {
            cancel.cancel();
        }
        self.views.clear();
        self.scope = Some((expected.generation, token));
        Ok(())
    }
    fn prune(&mut self) {
        self.previews
            .retain(|_, v| v.expires_at > chrono::Utc::now());
    }
}
impl SpacesWorkRelease {
    pub(crate) fn invalidate(&self) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| ACCESS_LOST)?;
        state.revision = state.revision.wrapping_add(1);
        state.pending.clear();
        state.previews.clear();
        for (_, cancel) in state.views.values() {
            cancel.cancel();
        }
        state.views.clear();
        Ok(())
    }
    pub(super) fn revision(&self, expected: &native_scope::Scope) -> Result<u64, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        Ok(state.revision)
    }
    pub(super) fn begin(
        &self,
        client: &str,
        expected: &native_scope::Scope,
    ) -> Result<(u64, CancellationToken), Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        if state.views.len() >= 8 && !state.views.contains_key(client) {
            return Err(Failure::Unavailable);
        }
        state.next = state.next.wrapping_add(1);
        let generation = state.next;
        let cancel = CancellationToken::new();
        if let Some((_, previous)) = state
            .views
            .insert(client.into(), (generation, cancel.clone()))
        {
            previous.cancel();
        }
        Ok((generation, cancel))
    }
    pub(super) fn current(&self, client: &str, generation: u64) -> Result<(), Failure> {
        let state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        if state
            .views
            .get(client)
            .is_some_and(|(v, c)| *v == generation && !c.is_cancelled())
        {
            Ok(())
        } else {
            Err(Failure::AccessLost)
        }
    }
    pub(super) fn cancel(&self, client: &str) -> Result<(), String> {
        if let Some((_, cancel)) = self.0.lock().map_err(|_| ACCESS_LOST)?.views.remove(client) {
            cancel.cancel();
        }
        Ok(())
    }
    pub(super) fn cache(
        &self,
        expected: &native_scope::Scope,
        preview: &Value,
        revision: u64,
    ) -> Result<(), Failure> {
        validate_preview(preview, &preview["release"])?;
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        // Global invalidation wins even if it races the last local scope check.
        // A late HTTP completion cannot repopulate cleared private native bytes.
        if state.revision != revision {
            return Err(Failure::AccessLost);
        }
        let id = string(&preview["release"], "id")?;
        if state.previews.len() >= 8 && !state.previews.contains_key(id) {
            return Err(Failure::Unavailable);
        }
        let serialized = serde_json::to_string(preview).map_err(|_| Failure::Invalid)?;
        if serialized.len() > 192_000 {
            return Err(Failure::Invalid);
        }
        state.previews.insert(
            id.into(),
            Cached {
                body: Zeroizing::new(serialized),
                expires_at: expiry(&preview["release"])?,
            },
        );
        Ok(())
    }
    pub(super) fn reviewed(
        &self,
        expected: &native_scope::Scope,
        record: &Value,
    ) -> Result<bool, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        Ok(state
            .previews
            .get(string(record, "id")?)
            .is_some_and(|cached| {
                serde_json::from_str::<Value>(&cached.body).is_ok_and(|preview| {
                    validate_preview(&preview, record).is_ok()
                        && preview["markdown"].as_str().is_some_and(reviewable_text)
                })
            }))
    }
    pub(super) fn reserve(
        &self,
        expected: &native_scope::Scope,
        id: &str,
        input: &DecisionInput,
    ) -> Result<DecisionInput, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        if let Some(pending) = state.pending.get(id) {
            if pending != input {
                return Err(Failure::Conflict);
            }
            return Ok(pending.clone());
        }
        if state.pending.len() >= RECORD_LIMIT {
            return Err(Failure::Unavailable);
        }
        state.pending.insert(id.into(), input.clone());
        Ok(input.clone())
    }
    pub(super) fn rejected(
        &self,
        expected: &native_scope::Scope,
        id: &str,
        operation: &str,
    ) -> Result<(), Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        if state
            .pending
            .get(id)
            .is_some_and(|p| p.operation_id == operation)
        {
            state.pending.remove(id);
        }
        Ok(())
    }
    pub(super) fn observe(
        &self,
        expected: &native_scope::Scope,
        thread: &ThreadInput,
        records: &[Value],
        complete: bool,
    ) -> Result<(), Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        // A complete empty owner lookup removes inaccessible reviews in this
        // thread. Truncated results may hide older records, but never return them.
        if complete {
            state.previews.retain(|id, cached| {
                serde_json::from_str::<Value>(&cached.body).is_ok_and(|v| {
                    v["release"]["terms"]["destination"] != thread.origin(expected)
                        || records.iter().any(|r| r["id"] == *id)
                })
            });
        }
        for record in records {
            let id = string(record, "id")?;
            if let Some(cached) = state.previews.get_mut(id) {
                let preview = serde_json::from_str::<Value>(&cached.body)
                    .ok()
                    .filter(|v| {
                        active(record)
                            && v["release"]["terms"] == record["terms"]
                            && v["release"]["termsDigest"] == record["termsDigest"]
                    });
                if let Some(mut preview) = preview {
                    preview["release"] = record.clone();
                    cached.body = Zeroizing::new(
                        serde_json::to_string(&preview).map_err(|_| Failure::Invalid)?,
                    );
                } else {
                    state.previews.remove(id);
                }
            }
            if state.pending.get(id).is_some_and(|p| {
                record["version"]
                    .as_u64()
                    .is_some_and(|v| v > p.expected_version)
                    || record["termsDigest"] != p.terms_digest
                    || !active(record)
                    || (p.decision != "revoke" && record["state"] != "pending")
            }) {
                state.pending.remove(id);
            }
        }
        Ok(())
    }
    pub(super) fn identity(
        &self,
        expected: &native_scope::Scope,
        records: &[Value],
    ) -> Result<Identity, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        let mut pending_decisions = BTreeMap::new();
        let mut previews = BTreeMap::new();
        for record in records {
            let id = string(record, "id")?;
            if let Some(p) = state.pending.get(id) {
                pending_decisions.insert(id.into(), p.clone());
            }
            if let Some(cached) = state.previews.get(id) {
                let preview: Value =
                    serde_json::from_str(&cached.body).map_err(|_| Failure::Invalid)?;
                if validate_preview(&preview, record).is_ok() {
                    previews.insert(id.into(), preview);
                }
            }
        }
        Ok(Identity {
            scope_token: scope_token(expected),
            principal_id: expected.config.identity_id.clone(),
            organisation_id: expected.config.org_id.clone(),
            pending_decisions,
            previews,
        })
    }
}
