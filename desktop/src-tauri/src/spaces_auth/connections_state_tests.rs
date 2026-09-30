use super::super::test_support::snapshot;
use super::*;

#[test]
fn replacement_and_hide_cancel_older_reads_without_restoring_cached_identity() {
    let state = SpacesConnections::default();
    let (first, first_cancel) = state.begin_read().unwrap();
    let (second, second_cancel) = state.begin_read().unwrap();
    assert!(first_cancel.is_cancelled());
    assert!(!second_cancel.is_cancelled());
    assert!(state.current(first).is_err());
    state.current(second).unwrap();
    state.cancel().unwrap();
    assert!(second_cancel.is_cancelled());
    assert!(state.finish(second, 1, Some(snapshot())).is_err());
    assert!(state.begin_action(1).is_err());
}

#[test]
fn mutation_is_single_flight_and_requires_current_identity_catalog() {
    let state = SpacesConnections::default();
    assert!(state.begin_action(1).is_err());
    let (read, _) = state.begin_read().unwrap();
    state.finish(read, 1, Some(snapshot())).unwrap();
    assert!(state.begin_action(2).is_err());
    let (action, cancellation, _) = state.begin_action(1).unwrap();
    assert!(state.begin_action(1).is_err());
    assert!(state.begin_read().is_err());
    assert!(!cancellation.is_cancelled());
    state.finish(action, 1, None).unwrap();
    assert!(state.begin_action(1).is_err());
    assert!(state.begin_read().is_ok());
}

#[test]
fn uncertain_access_request_keeps_its_intent_across_settings_close() {
    let state = SpacesConnections::default();
    let mut value = snapshot();
    value.entries[0].entitlement = "requestable".into();
    let entry = &value.entries[0];
    assert_eq!(
        state.request_key(1, entry, "first", "For work").unwrap(),
        "first"
    );
    state.cancel().unwrap();
    assert_eq!(
        state.request_key(1, entry, "second", "For work").unwrap(),
        "first"
    );
    assert!(state
        .request_key(1, entry, "third", "Different work")
        .is_err());
    let (read, _) = state.begin_read().unwrap();
    state.finish(read, 1, Some(value.clone())).unwrap();
    assert_eq!(
        state.request_key(1, entry, "fourth", "For work").unwrap(),
        "first"
    );
    state.invalidate().unwrap();
    assert_eq!(
        state
            .request_key(1, entry, "fifth", "Different work")
            .unwrap(),
        "fifth"
    );
    assert_eq!(
        state.request_key(2, entry, "sixth", "For work").unwrap(),
        "sixth"
    );
}
