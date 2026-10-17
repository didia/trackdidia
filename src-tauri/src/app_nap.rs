//! Keeps macOS from App-Napping the process while a deadline is pending.
//!
//! Once the window is hidden or occluded and the app is idle, App Nap coalesces and delays
//! every timer in the process, including the native Pomodoro alarm. Holding an activity
//! assertion opts out for as long as the guard lives. It still lets the system idle-sleep.

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

    pub struct ActivityGuard(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    // NSProcessInfo activity tokens are opaque and `beginActivity`/`endActivity` are
    // documented as thread-safe, so the token may be ended from any thread.
    unsafe impl Send for ActivityGuard {}

    impl ActivityGuard {
        pub fn begin(reason: &str) -> Self {
            let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                &NSString::from_str(reason),
            );
            Self(token)
        }
    }

    impl Drop for ActivityGuard {
        fn drop(&mut self) {
            // SAFETY: the token was returned by `beginActivityWithOptions:reason:`.
            unsafe { NSProcessInfo::processInfo().endActivity(&self.0) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub struct ActivityGuard;

    impl ActivityGuard {
        pub fn begin(_reason: &str) -> Self {
            Self
        }
    }
}

pub use imp::ActivityGuard;
