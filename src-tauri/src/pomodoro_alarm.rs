//! Native Pomodoro deadline alarm.
//!
//! The webview schedules session completion with JS timers, which macOS throttles or
//! suspends while the window is hidden or the app is in the background. This module keeps
//! one wall-clock deadline on the Rust side so the completion notification (with its
//! system sound) fires on time regardless of webview throttling, and wakes the frontend so
//! it can persist the completion.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

pub const ALARM_FIRED_EVENT: &str = "pomodoro-alarm-fired";
const NOTIFICATION_SOUND: &str = "Ping";
/// Upper bound for one sleep so a deadline is re-checked against the wall clock (tokio's
/// monotonic timers do not advance while the machine sleeps).
const MAX_SLEEP: Duration = Duration::from_secs(5);

#[derive(Default)]
struct AlarmSlot {
    generation: u64,
    deadline_ms: Option<i64>,
}

impl AlarmSlot {
    /// Replaces any pending alarm and returns the generation owning the new one.
    fn arm(&mut self, deadline_ms: i64) -> u64 {
        self.generation += 1;
        self.deadline_ms = Some(deadline_ms);
        self.generation
    }

    /// Cancels the alarm only while its deadline is still in the future. A deadline that has
    /// already passed is firing (or has fired) and must not be dropped by the frontend
    /// reacting to the same expiry.
    fn cancel_if_pending(&mut self, now_ms: i64) {
        if matches!(self.deadline_ms, Some(deadline) if deadline > now_ms) {
            self.generation += 1;
            self.deadline_ms = None;
        }
    }

    /// Returns true exactly once when `generation` still owns a deadline that is due.
    fn take_if_due(&mut self, generation: u64, now_ms: i64) -> bool {
        match self.deadline_ms {
            Some(deadline) if self.generation == generation && deadline <= now_ms => {
                self.deadline_ms = None;
                true
            }
            _ => false,
        }
    }

    /// Milliseconds left for `generation`, or None when it was replaced, cancelled or fired.
    fn remaining_ms(&self, generation: u64, now_ms: i64) -> Option<i64> {
        match self.deadline_ms {
            Some(deadline) if self.generation == generation => Some((deadline - now_ms).max(0)),
            _ => None,
        }
    }
}

#[derive(Default)]
pub struct PomodoroAlarmState {
    slot: Mutex<AlarmSlot>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn pomodoro_alarm_set(
    app: AppHandle,
    state: State<PomodoroAlarmState>,
    ends_at_ms: i64,
    title: String,
    body: String,
) -> Result<(), String> {
    let generation = state
        .slot
        .lock()
        .map_err(|_| "Etat alarme Pomodoro verrouille".to_string())?
        .arm(ends_at_ms);

    tauri::async_runtime::spawn(async move {
        loop {
            let remaining = {
                let state = app.state::<PomodoroAlarmState>();
                let slot = state
                    .slot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match slot.remaining_ms(generation, now_ms()) {
                    Some(remaining) => remaining,
                    None => return,
                }
            };
            if remaining > 0 {
                tokio::time::sleep(Duration::from_millis(remaining as u64).min(MAX_SLEEP)).await;
                continue;
            }

            let due = {
                let state = app.state::<PomodoroAlarmState>();
                let mut slot = state
                    .slot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                slot.take_if_due(generation, now_ms())
            };
            if due {
                let _ = app
                    .notification()
                    .builder()
                    .title(title.as_str())
                    .body(body.as_str())
                    .sound(NOTIFICATION_SOUND)
                    .show();
                let _ = app.emit(ALARM_FIRED_EVENT, ());
            }
            return;
        }
    });
    Ok(())
}

#[tauri::command]
pub fn pomodoro_alarm_clear(state: State<PomodoroAlarmState>) -> Result<(), String> {
    state
        .slot
        .lock()
        .map_err(|_| "Etat alarme Pomodoro verrouille".to_string())?
        .cancel_if_pending(now_ms());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_once_when_due() {
        let mut slot = AlarmSlot::default();
        let generation = slot.arm(1_000);
        assert!(!slot.take_if_due(generation, 999));
        assert!(slot.take_if_due(generation, 1_000));
        assert!(!slot.take_if_due(generation, 1_001));
    }

    #[test]
    fn rearming_supersedes_the_previous_alarm() {
        let mut slot = AlarmSlot::default();
        let first = slot.arm(1_000);
        let second = slot.arm(5_000);
        assert_eq!(slot.remaining_ms(first, 0), None);
        assert!(!slot.take_if_due(first, 6_000));
        assert!(slot.take_if_due(second, 6_000));
    }

    #[test]
    fn clear_cancels_a_pending_alarm() {
        let mut slot = AlarmSlot::default();
        let generation = slot.arm(1_000);
        slot.cancel_if_pending(500);
        assert_eq!(slot.remaining_ms(generation, 500), None);
        assert!(!slot.take_if_due(generation, 2_000));
    }

    #[test]
    fn clear_keeps_an_alarm_whose_deadline_has_passed() {
        let mut slot = AlarmSlot::default();
        let generation = slot.arm(1_000);
        slot.cancel_if_pending(1_000);
        assert!(slot.take_if_due(generation, 1_000));
    }

    #[test]
    fn remaining_never_goes_negative() {
        let mut slot = AlarmSlot::default();
        let generation = slot.arm(1_000);
        assert_eq!(slot.remaining_ms(generation, 400), Some(600));
        assert_eq!(slot.remaining_ms(generation, 5_000), Some(0));
    }
}
