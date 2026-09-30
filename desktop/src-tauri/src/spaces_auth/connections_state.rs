//! One native connection operation at a time, scoped to the current identity.
use super::{ConnectionEntry, ConnectionsSnapshot, CANCELLED};
use std::{collections::HashMap, sync::Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct SpacesConnections(Mutex<Operation>);

#[derive(Default)]
struct Operation {
    generation: u64,
    cancel: CancellationToken,
    active: bool,
    snapshot: Option<StoredSnapshot>,
    requests: HashMap<String, RequestIntent>,
}

struct RequestIntent {
    auth_generation: u64,
    key: String,
    reason: String,
    previous: Option<(String, i64, String)>,
}

#[derive(Clone)]
struct StoredSnapshot {
    auth_generation: u64,
    snapshot: ConnectionsSnapshot,
}

impl SpacesConnections {
    fn replace_operation(current: &mut Operation) -> (u64, CancellationToken) {
        current.cancel.cancel();
        current.generation = current.generation.wrapping_add(1);
        current.cancel = CancellationToken::new();
        current.active = true;
        (current.generation, current.cancel.clone())
    }

    pub(super) fn begin_read(&self) -> Result<(u64, CancellationToken), String> {
        let mut current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        if current.active && current.snapshot.is_some() {
            return Err("Wait for the current connection change to finish.".into());
        }
        let operation = Self::replace_operation(&mut current);
        current.snapshot = None;
        Ok(operation)
    }

    pub(super) fn begin_action(
        &self,
        auth_generation: u64,
    ) -> Result<(u64, CancellationToken, ConnectionsSnapshot), String> {
        let mut current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        if current.active {
            return Err("Wait for the current connection operation to finish.".into());
        }
        let snapshot = current
            .snapshot
            .as_ref()
            .filter(|stored| stored.auth_generation == auth_generation)
            .map(|stored| stored.snapshot.clone())
            .ok_or("Refresh connections before continuing.")?;
        let (generation, cancel) = Self::replace_operation(&mut current);
        Ok((generation, cancel, snapshot))
    }

    pub(super) fn finish(
        &self,
        operation_generation: u64,
        auth_generation: u64,
        snapshot: Option<ConnectionsSnapshot>,
    ) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        if current.generation != operation_generation || current.cancel.is_cancelled() {
            return Err(CANCELLED.into());
        }
        current.active = false;
        if let Some(value) = &snapshot {
            current.requests.retain(|connection_id, intent| {
                if intent.auth_generation != auth_generation {
                    return false;
                }
                value
                    .entries
                    .iter()
                    .find(|entry| entry.connection_id == *connection_id)
                    .is_some_and(|entry| {
                        entry.entitlement == "requestable"
                            && !entry.request.as_ref().is_some_and(|request| {
                                matches!(request.status.as_str(), "approved" | "rejected")
                                    && intent.previous.as_ref().is_none_or(
                                        |(id, version, status)| {
                                            request.id != *id
                                                || request.version > *version
                                                || request.status != *status
                                        },
                                    )
                            })
                    })
            });
        }
        current.snapshot = snapshot.map(|snapshot| StoredSnapshot {
            auth_generation,
            snapshot,
        });
        Ok(())
    }

    // Keep an uncertain request's identity in native memory across closing and
    // reopening Settings. The server deduplicates this exact human intent.
    pub(super) fn request_key(
        &self,
        auth_generation: u64,
        entry: &ConnectionEntry,
        proposed: &str,
        reason: &str,
    ) -> Result<String, String> {
        let mut current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        current
            .requests
            .retain(|_, intent| intent.auth_generation == auth_generation);
        if let Some(intent) = current.requests.get(&entry.connection_id) {
            if intent.reason != reason {
                return Err("Your earlier request is still unconfirmed. Refresh before changing its details.".into());
            }
            return Ok(intent.key.clone());
        }
        if current.requests.len() >= super::ENTRY_LIMIT {
            return Err("Refresh connections before sending another request.".into());
        }
        current.requests.insert(
            entry.connection_id.clone(),
            RequestIntent {
                auth_generation,
                key: proposed.into(),
                reason: reason.into(),
                previous: entry
                    .request
                    .as_ref()
                    .map(|request| (request.id.clone(), request.version, request.status.clone())),
            },
        );
        Ok(proposed.into())
    }

    pub(super) fn current(&self, generation: u64) -> Result<(), String> {
        let current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        if current.generation != generation || current.cancel.is_cancelled() {
            return Err(CANCELLED.into());
        }
        Ok(())
    }

    pub(crate) fn cancel(&self) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        current.cancel.cancel();
        current.generation = current.generation.wrapping_add(1);
        current.cancel = CancellationToken::new();
        current.active = false;
        current.snapshot = None;
        Ok(())
    }

    pub(crate) fn invalidate(&self) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        current.cancel.cancel();
        current.generation = current.generation.wrapping_add(1);
        current.cancel = CancellationToken::new();
        current.active = false;
        current.snapshot = None;
        current.requests.clear();
        Ok(())
    }
}

#[cfg(test)]
#[path = "connections_state_tests.rs"]
mod tests;
