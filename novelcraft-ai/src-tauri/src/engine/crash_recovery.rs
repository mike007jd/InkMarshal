//! Cold-start crash recovery for orphaned packaged inference engines on macOS.
//!
//! Force-killing the desktop app can leave a `setsid`'d `llama-server` /
//! `mlx-server` reparented to PID 1 while still listening and holding the
//! model. On the next launch we enumerate processes via `proc_list*`, capture
//! a `proc_bsdinfo` + `proc_pidpath` identity snapshot, and reap only group
//! leaders that still match that identity immediately before `killpg(SIGTERM)`.
//!
//! After SIGTERM the leader may exit while a TERM-ignoring descendant keeps
//! the process group alive. Escalation to SIGKILL validates every live
//! member's pgid + uid against the ownership token established at SIGTERM.
//!
//! Apple libproc note (XNU `libproc.c`): `__proc_info` failure is mapped to
//! return value `0` by `proc_listpids` / `proc_pidinfo` (errno preserved).
//! `proc_listpgrppids` then returns that byte count / `sizeof(int)`, so a
//! failure looks like a zero PID count — callers must clear/inspect errno and
//! must not treat zero/empty under an EPERM/`killpg` live group as Gone.

use std::path::{Component, Path, PathBuf};

const PACKAGED_ENGINE_DIR_SUFFIX: &[&str] = &[
    "InkMarshal.app",
    "Contents",
    "Resources",
    "engines",
    "aarch64-apple-darwin",
];
const PACKAGED_ENGINE_NAMES: &[&str] = &["llama-server", "mlx-server"];
const SIGTERM_GRACE: std::time::Duration = std::time::Duration::from_secs(2);
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

// ── Identity / outcomes ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessStartIdentity {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: u32,
    pub uid: u32,
    pub start_tvsec: u64,
    pub start_tvusec: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OrphanEngineCandidate {
    pub identity: ProcessStartIdentity,
    pub exe_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReapOutcome {
    /// Confirmed gone after a delivered recovery signal.
    Reaped,
    /// Group already absent before signaling.
    AlreadyGone,
    /// Identity / ownership mutated — left alone.
    IdentityChanged,
    /// Signal delivery failed, or pre-signal state could not be determined.
    SignalFailed,
    /// Confirmed still present after SIGTERM + SIGKILL.
    StillAlive,
    /// SIGKILL was attempted but post-kill group state could not be verified.
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GroupLiveness {
    Alive,
    Gone,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EscalateDecision {
    Gone,
    Escalate,
    IdentityChanged,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GroupOwnership {
    Owned,
    Foreign,
    Empty,
    Unknown,
}

/// Injectable per-member classification used by liveness and ownership gates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MemberProbe {
    Live { pgid: u32, uid: u32 },
    ConfirmedGoneOrZombie,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignalResult {
    Delivered,
    Gone,
    Failed,
}

// ── Path + eligibility (pure) ───────────────────────────────────────────────

pub(crate) fn is_packaged_inkmarshal_engine_path(path: &Path) -> bool {
    if !path.is_absolute() || path_has_dot_or_parent_segment(path) {
        return false;
    }
    let components: Vec<&str> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    let needed = PACKAGED_ENGINE_DIR_SUFFIX.len() + 1;
    if components.len() < needed {
        return false;
    }
    let engine_name = components[components.len() - 1];
    if !PACKAGED_ENGINE_NAMES.contains(&engine_name) {
        return false;
    }
    let dir_start = components.len() - needed;
    components[dir_start..components.len() - 1] == *PACKAGED_ENGINE_DIR_SUFFIX
}

fn path_has_dot_or_parent_segment(path: &Path) -> bool {
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return true;
    }
    path.to_str()
        .map(|s| s.split('/').any(|seg| seg == "." || seg == ".."))
        .unwrap_or(true)
}

pub(crate) fn should_reap_orphaned_engine(
    identity: &ProcessStartIdentity,
    exe_path: &Path,
    self_pid: u32,
    self_uid: u32,
) -> bool {
    identity.pid != 0
        && identity.pid != self_pid
        && identity.ppid == 1
        && identity.uid == self_uid
        && identity.pgid == identity.pid
        && is_packaged_inkmarshal_engine_path(exe_path)
}

pub(crate) fn start_identity_unchanged(
    original: &OrphanEngineCandidate,
    fresh: &OrphanEngineCandidate,
) -> bool {
    original.identity == fresh.identity && original.exe_path == fresh.exe_path
}

pub(crate) fn may_signal_orphan_candidate(
    original: &OrphanEngineCandidate,
    fresh: Option<&OrphanEngineCandidate>,
    self_pid: u32,
    self_uid: u32,
) -> bool {
    let Some(fresh) = fresh else {
        return false;
    };
    start_identity_unchanged(original, fresh)
        && should_reap_orphaned_engine(&fresh.identity, &fresh.exe_path, self_pid, self_uid)
}

// ── Pure membership classifiers (injectable seam) ───────────────────────────

/// Classify a raw `proc_listpgrppids` return. Apple maps `__proc_info` failure
/// to `proc_listpids` → `0` (errno set); `proc_listpgrppids` then returns
/// `0 / sizeof(int) == 0`. A negative count is not how failure is reported.
pub(crate) fn classify_listpgrppids_count(count: i32, errno_after: i32) -> Result<usize, i32> {
    if count < 0 {
        return Err(if errno_after != 0 { errno_after } else { -1 });
    }
    if count == 0 {
        return if errno_after != 0 {
            Err(errno_after)
        } else {
            Ok(0)
        };
    }
    Ok(count as usize)
}

/// Collapse member probes into group liveness. Unknown members poison the
/// result; only when every member is confirmed gone/zombie may we report Gone.
pub(crate) fn liveness_from_member_probes(probes: &[MemberProbe]) -> GroupLiveness {
    if probes.is_empty() {
        // Caller decides whether empty under EPERM is Unknown; this helper
        // treats an empty probe set as Unknown (never confirmed Gone).
        return GroupLiveness::Unknown;
    }
    let mut saw_live = false;
    let mut saw_unknown = false;
    for probe in probes {
        match probe {
            MemberProbe::Live { .. } => saw_live = true,
            MemberProbe::ConfirmedGoneOrZombie => {}
            MemberProbe::Unknown => saw_unknown = true,
        }
    }
    if saw_live {
        GroupLiveness::Alive
    } else if saw_unknown {
        GroupLiveness::Unknown
    } else {
        GroupLiveness::Gone
    }
}

/// Ownership gate: every live member must match expected pgid + uid. Any
/// unresolved member yields Unknown — never optimistic Owned.
pub(crate) fn ownership_from_member_probes(
    expected_pgid: u32,
    expected_uid: u32,
    probes: &[MemberProbe],
) -> GroupOwnership {
    if probes.is_empty() {
        return GroupOwnership::Empty;
    }
    let mut saw_owned_live = false;
    for probe in probes {
        match probe {
            MemberProbe::Live { pgid, uid } => {
                if *pgid != expected_pgid || *uid != expected_uid {
                    return GroupOwnership::Foreign;
                }
                saw_owned_live = true;
            }
            MemberProbe::ConfirmedGoneOrZombie => {}
            MemberProbe::Unknown => return GroupOwnership::Unknown,
        }
    }
    if saw_owned_live {
        GroupOwnership::Owned
    } else {
        GroupOwnership::Empty
    }
}

/// After a failed identity read: re-enumeration decides Gone vs Unknown.
pub(crate) fn probe_after_identity_query_failure(pid_still_listed: Option<bool>) -> MemberProbe {
    match pid_still_listed {
        Some(false) => MemberProbe::ConfirmedGoneOrZombie,
        Some(true) | None => MemberProbe::Unknown,
    }
}

// ── Public entry ────────────────────────────────────────────────────────────

pub fn reap_orphaned_packaged_engines() {
    #[cfg(target_os = "macos")]
    reap_orphaned_packaged_engines_macos();
}

#[cfg(target_os = "macos")]
fn reap_orphaned_packaged_engines_macos() {
    let self_pid = std::process::id();
    let self_uid = unsafe { libc::getuid() } as u32;

    let candidates = match discover_orphan_engine_candidates(self_pid, self_uid) {
        Ok(list) => list,
        Err(err) => {
            log::warn!("Engine crash recovery: cannot enumerate processes: {err}");
            return;
        }
    };
    if candidates.is_empty() {
        return;
    }

    let outcomes = terminate_validated_orphan_groups(candidates, self_pid, self_uid, |candidate| {
        snapshot_process(candidate.identity.pid)
    });
    for (candidate, outcome) in outcomes {
        match outcome {
            ReapOutcome::Reaped => log::warn!(
                "Reaped orphaned InkMarshal engine pid {} ({})",
                candidate.identity.pid,
                candidate.exe_path.display()
            ),
            ReapOutcome::AlreadyGone => log::warn!(
                "Orphaned InkMarshal engine pid {} disappeared before signaling ({})",
                candidate.identity.pid,
                candidate.exe_path.display()
            ),
            ReapOutcome::IdentityChanged => log::warn!(
                "Skipped orphaned InkMarshal engine pid {}: identity changed before signal",
                candidate.identity.pid
            ),
            ReapOutcome::SignalFailed => log::warn!(
                "Failed to signal orphaned InkMarshal engine pid {} ({})",
                candidate.identity.pid,
                candidate.exe_path.display()
            ),
            ReapOutcome::StillAlive => log::warn!(
                "Orphaned InkMarshal engine pid {} still alive after SIGKILL ({})",
                candidate.identity.pid,
                candidate.exe_path.display()
            ),
            ReapOutcome::Unverified => log::warn!(
                "Could not verify whether orphaned InkMarshal engine pid {} exited after SIGKILL ({})",
                candidate.identity.pid,
                candidate.exe_path.display()
            ),
        }
    }
}

#[cfg(target_os = "macos")]
fn discover_orphan_engine_candidates(
    self_pid: u32,
    self_uid: u32,
) -> Result<Vec<OrphanEngineCandidate>, String> {
    let mut out = Vec::new();
    for pid in list_all_pids()? {
        if pid == 0 || pid == self_pid {
            continue;
        }
        let Some(candidate) = snapshot_process(pid) else {
            continue;
        };
        if should_reap_orphaned_engine(&candidate.identity, &candidate.exe_path, self_pid, self_uid)
        {
            out.push(candidate);
        }
    }
    Ok(out)
}

// ── Termination state machine ───────────────────────────────────────────────

#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
pub(crate) fn terminate_validated_orphan_groups<F>(
    candidates: Vec<OrphanEngineCandidate>,
    self_pid: u32,
    self_uid: u32,
    mut refresh: F,
) -> Vec<(OrphanEngineCandidate, ReapOutcome)>
where
    F: FnMut(&OrphanEngineCandidate) -> Option<OrphanEngineCandidate>,
{
    use std::thread;
    use std::time::Instant;

    let mut signaled = Vec::new();
    let mut outcomes = Vec::new();

    for candidate in candidates {
        let fresh = refresh(&candidate);
        if !may_signal_orphan_candidate(&candidate, fresh.as_ref(), self_pid, self_uid) {
            let outcome = if fresh.is_none() {
                match process_group_liveness(candidate.identity.pgid as i32) {
                    GroupLiveness::Gone => ReapOutcome::AlreadyGone,
                    GroupLiveness::Alive => ReapOutcome::IdentityChanged,
                    GroupLiveness::Unknown => ReapOutcome::SignalFailed,
                }
            } else {
                ReapOutcome::IdentityChanged
            };
            outcomes.push((candidate, outcome));
            continue;
        }

        match signal_process_group(candidate.identity.pid as i32, libc::SIGTERM) {
            SignalResult::Delivered => signaled.push(candidate),
            SignalResult::Gone => outcomes.push((candidate, ReapOutcome::AlreadyGone)),
            SignalResult::Failed => outcomes.push((candidate, ReapOutcome::SignalFailed)),
        }
    }

    let deadline = Instant::now() + SIGTERM_GRACE;
    while Instant::now() < deadline {
        if signaled.iter().all(|c| {
            matches!(
                process_group_liveness(c.identity.pgid as i32),
                GroupLiveness::Gone
            )
        }) {
            break;
        }
        thread::sleep(POLL_INTERVAL);
    }

    for candidate in signaled {
        let fresh = refresh(&candidate);
        match decide_escalation(&candidate, fresh.as_ref(), self_pid, self_uid) {
            EscalateDecision::Gone => {
                outcomes.push((candidate, ReapOutcome::Reaped));
                continue;
            }
            EscalateDecision::IdentityChanged => {
                outcomes.push((candidate, ReapOutcome::IdentityChanged));
                continue;
            }
            EscalateDecision::Unknown => {
                outcomes.push((candidate, ReapOutcome::SignalFailed));
                continue;
            }
            EscalateDecision::Escalate => {}
        }

        match signal_process_group(candidate.identity.pid as i32, libc::SIGKILL) {
            SignalResult::Delivered | SignalResult::Gone => {
                let kill_deadline = Instant::now() + std::time::Duration::from_millis(500);
                while Instant::now() < kill_deadline {
                    if matches!(
                        process_group_liveness(candidate.identity.pgid as i32),
                        GroupLiveness::Gone
                    ) {
                        break;
                    }
                    thread::sleep(POLL_INTERVAL);
                }
                let outcome = match process_group_liveness(candidate.identity.pgid as i32) {
                    GroupLiveness::Gone => ReapOutcome::Reaped,
                    GroupLiveness::Alive => ReapOutcome::StillAlive,
                    // Honest: do not claim StillAlive when we could not verify.
                    GroupLiveness::Unknown => ReapOutcome::Unverified,
                };
                outcomes.push((candidate, outcome));
            }
            SignalResult::Failed => {
                let outcome = match process_group_liveness(candidate.identity.pgid as i32) {
                    GroupLiveness::Gone => ReapOutcome::Reaped,
                    GroupLiveness::Alive | GroupLiveness::Unknown => ReapOutcome::SignalFailed,
                };
                outcomes.push((candidate, outcome));
            }
        }
    }

    outcomes
}

/// Pre-SIGKILL gate: leader identity (when present) plus live-member ownership.
#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
fn decide_escalation(
    original: &OrphanEngineCandidate,
    fresh_leader: Option<&OrphanEngineCandidate>,
    self_pid: u32,
    self_uid: u32,
) -> EscalateDecision {
    match process_group_liveness(original.identity.pgid as i32) {
        GroupLiveness::Gone => return EscalateDecision::Gone,
        GroupLiveness::Unknown => return EscalateDecision::Unknown,
        GroupLiveness::Alive => {}
    }

    if let Some(fresh) = fresh_leader {
        if !may_signal_orphan_candidate(original, Some(fresh), self_pid, self_uid) {
            return EscalateDecision::IdentityChanged;
        }
    }

    // Every live member must match pgid + uid before SIGKILL — including the
    // leaderless case where refresh returns None.
    match live_group_ownership(original) {
        GroupOwnership::Owned => EscalateDecision::Escalate,
        GroupOwnership::Foreign => EscalateDecision::IdentityChanged,
        GroupOwnership::Empty | GroupOwnership::Unknown => EscalateDecision::Unknown,
    }
}

#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
pub(crate) fn signal_process_group(pgid: i32, signal: i32) -> SignalResult {
    if pgid <= 1 {
        return SignalResult::Failed;
    }
    let rc = unsafe { libc::killpg(pgid, signal) };
    if rc == 0 {
        return SignalResult::Delivered;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(errno) if errno == libc::ESRCH => SignalResult::Gone,
        _ => SignalResult::Failed,
    }
}

#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
pub(crate) fn process_group_liveness(pgid: i32) -> GroupLiveness {
    if pgid <= 1 {
        return GroupLiveness::Gone;
    }
    let rc = unsafe { libc::killpg(pgid, 0) };
    if rc == 0 {
        return GroupLiveness::Alive;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(errno) if errno == libc::ESRCH => GroupLiveness::Gone,
        #[cfg(target_os = "macos")]
        Some(errno) if errno == libc::EPERM => process_group_member_liveness(pgid),
        _ => GroupLiveness::Unknown,
    }
}

#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
fn live_group_ownership(original: &OrphanEngineCandidate) -> GroupOwnership {
    #[cfg(target_os = "macos")]
    {
        let pids = match list_process_group_pids(original.identity.pgid as i32) {
            Ok(pids) => pids,
            Err(()) => return GroupOwnership::Unknown,
        };
        // killpg already reported Alive; empty membership is inconsistent.
        if pids.is_empty() {
            return GroupOwnership::Unknown;
        }
        let probes: Vec<MemberProbe> = pids
            .iter()
            .map(|&pid| probe_group_member(original.identity.pgid as i32, pid))
            .collect();
        ownership_from_member_probes(original.identity.pgid, original.identity.uid, &probes)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux fixtures have no libproc membership APIs; killpg Alive after
        // pre-TERM identity validation is the ownership proof.
        let _ = original;
        GroupOwnership::Owned
    }
}

// ── macOS libproc backend ───────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn process_group_member_liveness(pgid: i32) -> GroupLiveness {
    // Entered only after killpg(EPERM): the group was addressable. Zero/empty
    // membership here is inconsistent / failed — never confirmed Gone.
    let pids = match list_process_group_pids(pgid) {
        Ok(pids) => pids,
        Err(()) => return GroupLiveness::Unknown,
    };
    if pids.is_empty() {
        return GroupLiveness::Unknown;
    }
    let probes: Vec<MemberProbe> = pids
        .iter()
        .map(|&pid| probe_group_member(pgid, pid))
        .collect();
    liveness_from_member_probes(&probes)
}

#[cfg(target_os = "macos")]
fn probe_group_member(pgid: i32, pid: u32) -> MemberProbe {
    match read_member_identity(pid) {
        IdentityRead::Live { pgid: m_pgid, uid } => MemberProbe::Live { pgid: m_pgid, uid },
        IdentityRead::Zombie => MemberProbe::ConfirmedGoneOrZombie,
        IdentityRead::Failed => {
            // Never treat query failure as zombie proof — re-enumerate.
            let still_listed = match list_process_group_pids(pgid) {
                Ok(pids) => Some(pids.contains(&pid)),
                Err(()) => None,
            };
            probe_after_identity_query_failure(still_listed)
        }
    }
}

#[cfg(target_os = "macos")]
fn clear_errno() {
    unsafe {
        *libc::__error() = 0;
    }
}

#[cfg(target_os = "macos")]
fn take_errno() -> i32 {
    unsafe { *libc::__error() }
}

/// Dynamically sized `proc_listpgrppids`. Failure is `0` + errno (Apple), not
/// a negative count.
#[cfg(target_os = "macos")]
fn list_process_group_pids(pgid: i32) -> Result<Vec<u32>, ()> {
    if pgid <= 1 {
        return Ok(Vec::new());
    }
    let mut capacity = 64usize;
    for _ in 0..8 {
        let mut buf = vec![0i32; capacity];
        clear_errno();
        let count = unsafe {
            libc::proc_listpgrppids(
                pgid,
                buf.as_mut_ptr().cast::<libc::c_void>(),
                (buf.len() * std::mem::size_of::<i32>()) as i32,
            )
        };
        let errno_after = take_errno();
        let count = match classify_listpgrppids_count(count, errno_after) {
            Ok(n) => n,
            Err(_) => return Err(()),
        };
        if count < buf.len() {
            return Ok(buf
                .into_iter()
                .take(count)
                .filter(|pid| *pid > 0)
                .map(|pid| pid as u32)
                .collect());
        }
        capacity = capacity.saturating_mul(2).max(count + 16);
    }
    Err(())
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdentityRead {
    Live { pgid: u32, uid: u32 },
    Zombie,
    Failed,
}

#[cfg(target_os = "macos")]
fn read_member_identity(pid: u32) -> IdentityRead {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    clear_errno();
    let ret = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast::<libc::c_void>(),
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    // Apple: __proc_info failure → proc_pidinfo returns 0 (errno set).
    if ret as usize != std::mem::size_of::<libc::proc_bsdinfo>() || info.pbi_pid != pid {
        return IdentityRead::Failed;
    }
    if info.pbi_status == libc::SZOMB {
        return IdentityRead::Zombie;
    }
    IdentityRead::Live {
        pgid: info.pbi_pgid,
        uid: info.pbi_uid as u32,
    }
}

#[cfg(target_os = "macos")]
fn list_all_pids() -> Result<Vec<u32>, String> {
    // proc_listpids returns a byte count; failure is mapped to 0 + errno.
    const PROC_ALL_PIDS: u32 = 1;
    clear_errno();
    let hint = unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    let hint_errno = take_errno();
    if hint <= 0 {
        return Err(format!(
            "proc_listpids hint failed (ret={hint}, errno={hint_errno})"
        ));
    }
    let mut buf = vec![0i32; (hint as usize / std::mem::size_of::<i32>()) + 64];
    clear_errno();
    let bytes = unsafe {
        libc::proc_listpids(
            PROC_ALL_PIDS,
            0,
            buf.as_mut_ptr().cast(),
            (buf.len() * std::mem::size_of::<i32>()) as i32,
        )
    };
    let fill_errno = take_errno();
    if bytes <= 0 {
        return Err(format!(
            "proc_listpids fill failed (ret={bytes}, errno={fill_errno})"
        ));
    }
    let count = (bytes as usize) / std::mem::size_of::<i32>();
    Ok(buf
        .into_iter()
        .take(count)
        .filter(|pid| *pid > 0)
        .map(|pid| pid as u32)
        .collect())
}

#[cfg(target_os = "macos")]
fn snapshot_process(pid: u32) -> Option<OrphanEngineCandidate> {
    let identity = read_bsdinfo(pid)?;
    let exe_path = resolve_executable_path(pid)?;
    Some(OrphanEngineCandidate { identity, exe_path })
}

#[cfg(target_os = "macos")]
fn read_bsdinfo(pid: u32) -> Option<ProcessStartIdentity> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    clear_errno();
    let ret = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast::<libc::c_void>(),
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if ret as usize != std::mem::size_of::<libc::proc_bsdinfo>() || info.pbi_pid != pid {
        return None;
    }
    if info.pbi_status == libc::SZOMB {
        return None;
    }
    Some(ProcessStartIdentity {
        pid: info.pbi_pid,
        ppid: info.pbi_ppid,
        pgid: info.pbi_pgid,
        uid: info.pbi_uid as u32,
        start_tvsec: info.pbi_start_tvsec,
        start_tvusec: info.pbi_start_tvusec,
    })
}

#[cfg(target_os = "macos")]
fn resolve_executable_path(pid: u32) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    clear_errno();
    let ret = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buf.as_mut_ptr().cast::<libc::c_void>(),
            buf.len() as u32,
        )
    };
    if ret <= 0 {
        return None;
    }
    let path = std::str::from_utf8(&buf[..ret as usize]).ok()?;
    if path.is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn packaged(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    fn orphan_identity(pid: u32, uid: u32) -> ProcessStartIdentity {
        ProcessStartIdentity {
            pid,
            ppid: 1,
            pgid: pid,
            uid,
            start_tvsec: 100,
            start_tvusec: 200,
        }
    }

    fn orphan_candidate(pid: u32, uid: u32) -> OrphanEngineCandidate {
        OrphanEngineCandidate {
            identity: orphan_identity(pid, uid),
            exe_path: packaged(
                "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/llama-server",
            ),
        }
    }

    #[test]
    fn accepts_applications_and_app_translocation_engine_paths() {
        assert!(is_packaged_inkmarshal_engine_path(&packaged(
            "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/llama-server",
        )));
        assert!(is_packaged_inkmarshal_engine_path(&packaged(
            "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/mlx-server",
        )));
        assert!(is_packaged_inkmarshal_engine_path(&packaged(
            "/private/var/folders/fm/x/T/AppTranslocation/UUID/d/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/llama-server",
        )));
    }

    #[test]
    fn rejects_foreign_lookalike_and_parent_dir_engine_paths() {
        for path in [
            "/opt/homebrew/bin/llama-server",
            "/Applications/NotInkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/llama-server",
            "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/llama-server.bak",
            "InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/llama-server",
            "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/./llama-server",
            "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/../aarch64-apple-darwin/llama-server",
        ] {
            assert!(
                !is_packaged_inkmarshal_engine_path(Path::new(path)),
                "should reject {path}"
            );
        }
    }

    #[test]
    fn eligibility_requires_ppid1_uid_pgid_leader_and_packaged_path() {
        let uid = 501;
        let self_pid = 9000;
        let good = orphan_identity(73331, uid);
        let path = packaged(
            "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/llama-server",
        );
        assert!(should_reap_orphaned_engine(&good, &path, self_pid, uid));
        let mut live_parent = good.clone();
        live_parent.ppid = 42;
        assert!(!should_reap_orphaned_engine(
            &live_parent,
            &path,
            self_pid,
            uid
        ));
        let mut wrong_uid = good.clone();
        wrong_uid.uid = uid + 1;
        assert!(!should_reap_orphaned_engine(
            &wrong_uid, &path, self_pid, uid
        ));
        let mut non_leader = good.clone();
        non_leader.pgid = good.pid + 1;
        assert!(!should_reap_orphaned_engine(
            &non_leader,
            &path,
            self_pid,
            uid
        ));
        assert!(!should_reap_orphaned_engine(
            &good,
            &packaged("/opt/homebrew/bin/llama-server"),
            self_pid,
            uid
        ));
    }

    #[test]
    fn identity_mutation_blocks_signal_before_killpg() {
        let uid = 501;
        let original = orphan_candidate(73331, uid);
        assert!(may_signal_orphan_candidate(
            &original,
            Some(&original),
            9000,
            uid
        ));
        assert!(!may_signal_orphan_candidate(&original, None, 9000, uid));
        let mut mutated = original.clone();
        mutated.identity.start_tvsec += 1;
        assert!(!may_signal_orphan_candidate(
            &original,
            Some(&mutated),
            9000,
            uid
        ));
    }

    #[test]
    fn listpgrppids_zero_with_errno_is_failure() {
        // Apple maps __proc_info failure to ret=0 with errno set (EPERM=1, EIO=5).
        assert_eq!(classify_listpgrppids_count(0, 1), Err(1));
        assert_eq!(classify_listpgrppids_count(0, 5), Err(5));
        assert_eq!(classify_listpgrppids_count(0, 0), Ok(0));
        assert_eq!(classify_listpgrppids_count(3, 0), Ok(3));
        assert!(classify_listpgrppids_count(-1, 0).is_err());
    }

    #[test]
    fn empty_membership_under_eperm_path_is_unknown_not_gone() {
        // Empty probe set / empty list after EPERM must not become Gone.
        assert_eq!(liveness_from_member_probes(&[]), GroupLiveness::Unknown);
        assert_eq!(
            ownership_from_member_probes(10, 501, &[]),
            GroupOwnership::Empty
        );
    }

    #[test]
    fn per_member_failure_still_listed_is_unknown() {
        assert_eq!(
            probe_after_identity_query_failure(Some(true)),
            MemberProbe::Unknown
        );
        assert_eq!(
            probe_after_identity_query_failure(None),
            MemberProbe::Unknown
        );
        let probes = [MemberProbe::Unknown];
        assert_eq!(liveness_from_member_probes(&probes), GroupLiveness::Unknown);
        assert_eq!(
            ownership_from_member_probes(10, 501, &probes),
            GroupOwnership::Unknown
        );
    }

    #[test]
    fn per_member_failure_then_disappeared_is_confirmed_gone() {
        assert_eq!(
            probe_after_identity_query_failure(Some(false)),
            MemberProbe::ConfirmedGoneOrZombie
        );
        let probes = [MemberProbe::ConfirmedGoneOrZombie];
        assert_eq!(liveness_from_member_probes(&probes), GroupLiveness::Gone);
        assert_eq!(
            ownership_from_member_probes(10, 501, &probes),
            GroupOwnership::Empty
        );
    }

    #[test]
    fn ownership_requires_every_live_member_pgid_and_uid() {
        let probes = [
            MemberProbe::Live { pgid: 10, uid: 501 },
            MemberProbe::Live { pgid: 10, uid: 502 },
        ];
        assert_eq!(
            ownership_from_member_probes(10, 501, &probes),
            GroupOwnership::Foreign
        );
        let owned = [
            MemberProbe::Live { pgid: 10, uid: 501 },
            MemberProbe::ConfirmedGoneOrZombie,
        ];
        assert_eq!(
            ownership_from_member_probes(10, 501, &owned),
            GroupOwnership::Owned
        );
        let poisoned = [
            MemberProbe::Live { pgid: 10, uid: 501 },
            MemberProbe::Unknown,
        ];
        assert_eq!(
            ownership_from_member_probes(10, 501, &poisoned),
            GroupOwnership::Unknown
        );
    }

    #[test]
    fn post_sigkill_unknown_maps_to_unverified_not_still_alive() {
        // Document the state-machine contract used by terminate_validated_orphan_groups.
        let outcome = match GroupLiveness::Unknown {
            GroupLiveness::Gone => ReapOutcome::Reaped,
            GroupLiveness::Alive => ReapOutcome::StillAlive,
            GroupLiveness::Unknown => ReapOutcome::Unverified,
        };
        assert_eq!(outcome, ReapOutcome::Unverified);
        assert_ne!(outcome, ReapOutcome::StillAlive);
        assert_ne!(outcome, ReapOutcome::AlreadyGone);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn production_shaped_refresh(
        candidate: &OrphanEngineCandidate,
    ) -> Option<OrphanEngineCandidate> {
        if leader_is_snapshottable(candidate.identity.pid) {
            Some(candidate.clone())
        } else {
            None
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn leader_is_snapshottable(pid: u32) -> bool {
        #[cfg(target_os = "macos")]
        {
            matches!(read_member_identity(pid), IdentityRead::Live { .. })
        }
        #[cfg(not(target_os = "macos"))]
        {
            unsafe { libc::kill(pid as i32, 0) == 0 }
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    struct ProcessGroupFixture {
        pgid: u32,
        reaper: Option<std::thread::JoinHandle<()>>,
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    impl ProcessGroupFixture {
        fn pgid(&self) -> u32 {
            self.pgid
        }

        fn cleanup(&mut self) {
            if self.reaper.is_none() {
                return;
            }
            let _ = signal_process_group(self.pgid as i32, libc::SIGKILL);
            if let Some(reaper) = self.reaper.take() {
                let _ = reaper.join();
            }
        }

        fn finish(mut self) {
            self.cleanup();
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    impl Drop for ProcessGroupFixture {
        fn drop(&mut self) {
            self.cleanup();
        }
    }

    /// Concurrently reap the direct child leader so unreaped zombies do not
    /// appear — production orphans are PPID 1 and reaped by launchd. The
    /// fixture owns the full process group and kills it on assertion unwind.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn spawn_setsid_reaped(script: &str) -> ProcessGroupFixture {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("spawn setsid /bin/sh fixture");
        let pid = child.id();
        let handle = std::thread::spawn(move || {
            // Reap as soon as the leader exits — mirrors launchd for PPID-1 orphans.
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                    Err(_) => break,
                }
            }
        });
        ProcessGroupFixture {
            pgid: pid,
            reaper: Some(handle),
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn terminate_reaps_setsid_child_with_production_refresh() {
        let fixture = spawn_setsid_reaped("exec sleep 30");
        let pgid = fixture.pgid();
        assert!(pgid > 1);

        let uid = unsafe { libc::getuid() } as u32;
        let outcomes = terminate_validated_orphan_groups(
            vec![orphan_candidate(pgid, uid)],
            0,
            uid,
            production_shaped_refresh,
        );
        assert_eq!(outcomes.len(), 1);
        assert!(
            matches!(
                outcomes[0].1,
                ReapOutcome::Reaped | ReapOutcome::AlreadyGone
            ),
            "unexpected {:?}",
            outcomes[0].1
        );
        assert!(matches!(
            process_group_liveness(pgid as i32),
            GroupLiveness::Gone
        ));
        fixture.finish();
    }

    /// Leader exits on SIGTERM; descendant ignores it. Concurrent reaper
    /// collects the leader (production PPID-1 shape). Refresh returns None;
    /// escalation uses live-member ownership then SIGKILL.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn production_refresh_escalates_leaderless_term_ignoring_descendant() {
        // Background sleep ignores TERM; leader sleep takes default disposition.
        let fixture = spawn_setsid_reaped(
            r#"( /bin/sh -c 'trap "" TERM; exec sleep 1000' ) & exec sleep 1000"#,
        );
        let pgid = fixture.pgid();
        assert!(pgid > 1);
        std::thread::sleep(std::time::Duration::from_millis(150));

        let uid = unsafe { libc::getuid() } as u32;
        let candidate = orphan_candidate(pgid, uid);
        let mut refresh_calls = 0usize;
        let outcomes = terminate_validated_orphan_groups(vec![candidate], 0, uid, |c| {
            refresh_calls += 1;
            production_shaped_refresh(c)
        });

        assert_eq!(outcomes.len(), 1);
        assert!(
            matches!(
                outcomes[0].1,
                ReapOutcome::Reaped | ReapOutcome::AlreadyGone
            ),
            "unexpected {:?}",
            outcomes[0].1
        );
        assert!(
            refresh_calls >= 2,
            "expected pre-TERM and post-grace refresh; got {refresh_calls}"
        );
        assert!(!leader_is_snapshottable(pgid));
        assert!(matches!(
            process_group_liveness(pgid as i32),
            GroupLiveness::Gone
        ));
        fixture.finish();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn shared_grace_deadline_batches_multiple_groups() {
        use std::time::Instant;

        let fixture_a = spawn_setsid_reaped("exec sleep 30");
        let fixture_b = spawn_setsid_reaped("exec sleep 30");
        let pid_a = fixture_a.pgid();
        let pid_b = fixture_b.pgid();
        let uid = unsafe { libc::getuid() } as u32;
        let mut mlx = orphan_candidate(pid_b, uid);
        mlx.exe_path = packaged(
            "/Applications/InkMarshal.app/Contents/Resources/engines/aarch64-apple-darwin/mlx-server",
        );

        let started = Instant::now();
        let outcomes = terminate_validated_orphan_groups(
            vec![orphan_candidate(pid_a, uid), mlx],
            0,
            uid,
            production_shaped_refresh,
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed < SIGTERM_GRACE + std::time::Duration::from_secs(2),
            "batched grace should not stack; elapsed={elapsed:?}"
        );
        assert_eq!(outcomes.len(), 2);
        for (_, outcome) in &outcomes {
            assert!(
                matches!(outcome, ReapOutcome::Reaped | ReapOutcome::AlreadyGone),
                "unexpected {outcome:?}"
            );
        }
        fixture_a.finish();
        fixture_b.finish();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn decide_escalation_skips_when_group_already_gone() {
        let uid = unsafe { libc::getuid() } as u32;
        let missing = orphan_candidate(0x7fff_fffe, uid);
        assert_eq!(
            decide_escalation(&missing, None, 0, uid),
            EscalateDecision::Gone
        );
    }
}
