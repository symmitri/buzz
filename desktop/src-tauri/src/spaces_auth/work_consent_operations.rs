//! Bounded native view cancellation and uncertain decision metadata. Nothing is
//! persisted, and closing Settings/thread views does not discard a submitted ID.
use super::*;
use std::{collections::BTreeMap, sync::Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct SpacesWorkConsent(Mutex<State>);
#[derive(Default)]
struct State {
    next: u64,
    views: BTreeMap<String, (u64, CancellationToken)>,
    scope: Option<(u64, String)>,
    pending: BTreeMap<String, DecisionInput>,
    selections: BTreeMap<String, PendingSelection>,
}
struct PendingSelection {
    work_id: String,
    channel_id: String,
    root_event_id: String,
    input: SelectionInput,
}
impl PendingSelection {
    fn in_thread(&self, thread: &ThreadInput, work_id: &str) -> bool {
        self.work_id == work_id
            && self.channel_id == thread.channel_id
            && self.root_event_id == thread.root_event_id
    }
}
impl State {
    fn scope(&mut self, expected: &native_scope::Scope) -> Result<(), Failure> {
        let token = scope_token(expected);
        if let Some((generation, current)) = &self.scope {
            if *generation > expected.generation
                || (*generation == expected.generation && *current != token)
            {
                return Err(Failure::AccessLost);
            }
            if *generation == expected.generation {
                return Ok(());
            }
        }
        self.pending.clear();
        self.selections.clear();
        self.scope = Some((expected.generation, token));
        Ok(())
    }
}
impl SpacesWorkConsent {
    pub(crate) fn invalidate(&self) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| ACCESS_LOST)?;
        state.pending.clear();
        state.selections.clear();
        for (_, cancel) in state.views.values() {
            cancel.cancel();
        }
        state.views.clear();
        Ok(())
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
            .is_some_and(|(value, cancel)| *value == generation && !cancel.is_cancelled())
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
    pub(super) fn reserve_selection(
        &self,
        expected: &native_scope::Scope,
        thread: &ThreadInput,
        work_id: &str,
        id: &str,
        input: &SelectionInput,
        eligible: bool,
    ) -> Result<SelectionInput, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        if let Some(pending) = state.selections.get(id) {
            if !pending.in_thread(thread, work_id) || !pending.input.same_terms(input) {
                return Err(Failure::Conflict);
            }
            return Ok(pending.input.clone());
        }
        if !eligible {
            return Err(Failure::Conflict);
        }
        if state.selections.len() >= REQUEST_LIMIT {
            return Err(Failure::Unavailable);
        }
        state.selections.insert(
            id.into(),
            PendingSelection {
                work_id: work_id.into(),
                channel_id: thread.channel_id.clone(),
                root_event_id: thread.root_event_id.clone(),
                input: input.clone(),
            },
        );
        Ok(input.clone())
    }
    pub(super) fn reject_selection(
        &self,
        expected: &native_scope::Scope,
        id: &str,
        operation: &str,
    ) -> Result<(), Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        if state
            .selections
            .get(id)
            .is_some_and(|p| p.input.operation_id == operation)
        {
            state.selections.remove(id);
        }
        Ok(())
    }
    pub(super) fn observe_selections(
        &self,
        expected: &native_scope::Scope,
        thread: &ThreadInput,
        work_id: &str,
        bound: Option<(&str, &Record)>,
    ) -> Result<BTreeMap<String, SelectionInput>, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        // A current authenticated binding settles the per-owner selection. Its
        // absence, expiry or disappearance from unbound pages settles nothing.
        if let Some((id, consent)) = bound {
            if consent.terms.task.work_id != work_id {
                return Err(Failure::AccessLost);
            }
            if state
                .selections
                .get(id)
                .is_some_and(|p| p.in_thread(thread, work_id))
            {
                state.selections.remove(id);
            }
        }
        Ok(state
            .selections
            .iter()
            .filter(|(_, p)| p.in_thread(thread, work_id))
            .map(|(id, p)| (id.clone(), p.input.clone()))
            .collect())
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
            if pending.expected_version != input.expected_version
                || pending.terms_digest != input.terms_digest
                || pending.decision != input.decision
            {
                return Err(Failure::Conflict);
            }
            // An explicit retry reuses the first submitted operation even if a
            // remounted renderer generated a new candidate ID.
            return Ok(pending.clone());
        }
        if state.pending.len() >= REQUEST_LIMIT {
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
            .is_some_and(|pending| pending.operation_id == operation)
        {
            state.pending.remove(id);
        }
        Ok(())
    }
    pub(super) fn observe(
        &self,
        expected: &native_scope::Scope,
        records: &[&Record],
    ) -> Result<BTreeMap<String, DecisionInput>, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::AccessLost)?;
        state.scope(expected)?;
        // Expiry/staleness may be projected without advancing the stored version.
        // At the same version, retain an uncertain revoke until stop is confirmed.
        for record in records {
            if state.pending.get(&record.id).is_some_and(|p| {
                record.version > p.expected_version
                    || record.terms_digest != p.terms_digest
                    || match p.decision {
                        Decision::Approve | Decision::Decline => {
                            record.state != ConsentState::Pending
                        }
                        Decision::Revoke => {
                            matches!(record.state, ConsentState::Declined | ConsentState::Revoked)
                        }
                    }
            }) {
                state.pending.remove(&record.id);
            }
        }
        Ok(records
            .iter()
            .filter_map(|r| state.pending.get(&r.id).cloned().map(|p| (r.id.clone(), p)))
            .collect())
    }
}
