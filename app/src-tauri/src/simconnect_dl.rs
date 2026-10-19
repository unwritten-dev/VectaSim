//! "SimConnect herunterladen": fetch SimConnect.dll on the user's click from Microsoft's own
//! SDK server instead of shipping it with the installer.
//!
//! Why not bundle it: the MSFS SDK EULA only allows distributing "distributable code" and no
//! Microsoft document names SimConnect.dll as such (see DEVELOPMENT.md, "SimConnect").
//! So VectaSim never hosts or ships the file. On request it downloads the official MSFS 2020
//! SDK Core installer (pinned version and SHA-256), takes the one cabinet that holds the DLL out
//! of the ZIP, extracts the DLL with Windows' own `expand.exe` (the MSI is never run) and
//! keeps only the DLL, verified by its pinned SHA-256, in
//! `%LOCALAPPDATA%\io.vectasim.app\simconnect\` – where the loader looks right after the
//! `VECTASIM_SIMCONNECT_DLL` override (`vectasim_simconnect::ffi::candidate_paths`).
//!
//! The 2020 client DLL also talks to MSFS 2024 (Asobo: "you can use an MSFS2020 dll"), and the
//! 2020 SDK download is ~108 MB against ~650 MB for the 2024 SDK Core.
//!
//! The NSIS installer offers the same download after an interactive install (user's Yes in a
//! dialog, `app/src-tauri/windows/hooks.nsi`) through the headless mode [`run_cli`]:
//! `vectasim.exe --install-simconnect [--check]`.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, State};
use vectasim_data::AirportIndex;
use vectasim_simconnect::ffi;
use vectasim_store::Store;

use crate::manager::ProviderManager;

/// MSFS 2020 SDK Core version the DLL is taken from.
pub const SDK_VERSION: &str = "0.24.6.0";
/// Official download (listed in `https://sdk.flightsimulator.com/files/sdk.json` for sim 1.37.18.0).
pub const SDK_ZIP_URL: &str = "https://sdk.flightsimulator.com/files/installers/0.24.6/MSFS_SDK_Core_Installer_0.24.6.0.zip";
const SDK_ZIP_SIZE: u64 = 113_306_986;
const SDK_ZIP_SHA256: &str = "6daaa1fa45598d890d17b1c8347cd736e529c83bfc00630fcefe8822500eaf3f";
/// Cabinet inside the ZIP that holds `SimConnect SDK\lib\SimConnect.dll` (MSI `Media` DiskId 1).
const CAB_ENTRY: &str = "MSFS_SDK_Core_Installer_0.24.6.0/cab1.cab";
/// MSI `File` table key of `SimConnect SDK\lib\SimConnect.dll` = its name inside the cabinet.
const CAB_FILE_KEY: &str = "filtEQeYbpLedi0MhYth1bxHyr8SqE";
const DLL_SIZE: u64 = 67_072;
const DLL_SHA256: &str = "cffb74b62b596a897b0ff101bac3d66ea10236c540c75864658b451ffd1e6513";
/// Licence terms the user accepts by downloading the SDK.
pub const EULA_URL: &str = "https://docs.flightsimulator.com/html/Introduction/SDK_EULA.htm";
/// Event with [`Progress`] while `download_simconnect` runs.
pub const PROGRESS_EVENT: &str = "simconnect-download";

static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// download | verify | extract | done
    phase: &'static str,
    received: u64,
    total: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimConnectDownloadInfo {
    /// The downloaded DLL exists and matches the pinned hash.
    installed: bool,
    path: Option<String>,
    sdk_version: &'static str,
    download_bytes: u64,
    source_url: &'static str,
    eula_url: &'static str,
    /// Set by `download_simconnect`: the SimConnect provider was restarted to pick the DLL up.
    restarted: bool,
}

fn info(restarted: bool) -> SimConnectDownloadInfo {
    let path = ffi::downloaded_dll_path();
    let installed = path.as_deref().is_some_and(|p| verify_file(p, DLL_SIZE, DLL_SHA256).is_ok());
    SimConnectDownloadInfo {
        installed,
        path: path.map(|p| p.display().to_string()),
        sdk_version: SDK_VERSION,
        download_bytes: SDK_ZIP_SIZE,
        source_url: SDK_ZIP_URL,
        eula_url: EULA_URL,
        restarted,
    }
}

/// State of the in-app download for Einstellungen → Simulator.
#[tauri::command]
pub fn simconnect_download_info() -> SimConnectDownloadInfo {
    info(false)
}

/// Download SimConnect.dll (user-initiated, see module docs). Emits [`PROGRESS_EVENT`]; restarts
/// the SimConnect provider afterwards when it is selected, not connected and no flight is open.
#[tauri::command]
pub async fn download_simconnect(
    app: AppHandle,
    manager: State<'_, ProviderManager>,
    store: State<'_, Store>,
    airports: State<'_, Arc<AirportIndex>>,
) -> Result<SimConnectDownloadInfo, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err(crate::lang::tr("Der Download läuft bereits.", "The download is already running.").into());
    }
    let worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        fetch(&|p| {
            let _ = worker.emit(PROGRESS_EVENT, p);
        })
    })
    .await;
    BUSY.store(false, Ordering::SeqCst);
    let dll = result.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    log::info!("SimConnect.dll downloaded from the MSFS SDK {SDK_VERSION} to {}", dll.display());

    let snap = manager.snapshot();
    let restart = snap.provider == "simconnect" && snap.state != "connected" && manager.current_flight_id().is_none();
    if restart {
        manager.start(app, store.inner().clone(), Arc::new(crate::IndexResolver(airports.inner().clone())), "sim")?;
    }
    Ok(info(restart))
}

/// Command-line flag of the headless mode the NSIS installer calls (`windows/hooks.nsi`).
pub const CLI_FLAG: &str = "--install-simconnect";
/// With [`CLI_FLAG`]: only report whether a usable DLL is present (exit 0) or not (exit 1).
pub const CLI_CHECK_FLAG: &str = "--check";
/// Exit codes of the headless mode.
pub const EXIT_OK: i32 = 0;
pub const EXIT_OTHER: i32 = 1;
pub const EXIT_NETWORK: i32 = 2;
pub const EXIT_CHECKSUM: i32 = 3;
/// Log of the headless runs, next to `vectasim.log`.
const CLI_LOG_FILE: &str = "simconnect-install.log";

/// Headless entry point: `Some(exit code)` when the process was started with [`CLI_FLAG`]
/// (then no window, no Tauri builder, no single-instance hand-over), `None` for a normal start.
pub fn run_cli(args: &[std::ffi::OsString]) -> Option<i32> {
    let args: Vec<&std::ffi::OsStr> = args.iter().skip(1).map(|a| a.as_os_str()).collect();
    if !args.iter().any(|a| *a == CLI_FLAG) {
        return None;
    }
    let log = CliLog::open();
    if args.iter().any(|a| *a == CLI_CHECK_FLAG) {
        return Some(match usable_dll() {
            Some(p) => {
                log.line(&format!("{CLI_FLAG} {CLI_CHECK_FLAG}: SimConnect.dll vorhanden ({}, {})", p.display(), ffi::dll_source(&p).label()));
                EXIT_OK
            }
            None => {
                log.line(&format!("{CLI_FLAG} {CLI_CHECK_FLAG}: keine SimConnect.dll gefunden"));
                EXIT_OTHER
            }
        });
    }
    if let Some(dest) = ffi::downloaded_dll_path()
        && verify_file(&dest, DLL_SIZE, DLL_SHA256).is_ok()
    {
        log.line(&format!("{CLI_FLAG}: {} ist bereits vorhanden und geprüft (SHA-256: {DLL_SHA256})", dest.display()));
        return Some(EXIT_OK);
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return Some(EXIT_OTHER);
    }
    log.line(&format!("{CLI_FLAG}: Download des MSFS SDK {SDK_VERSION} (Core) von {SDK_ZIP_URL}"));
    let started = std::time::Instant::now();
    let last_decile = std::sync::atomic::AtomicU64::new(u64::MAX);
    let result = fetch(&|p: Progress| {
        if p.phase == "download" {
            let decile = (p.received.saturating_mul(10) / p.total.max(1)).min(10);
            if last_decile.swap(decile, Ordering::Relaxed) != decile {
                eprintln!("download {} %  ({} / {} Bytes)", decile * 10, p.received, p.total);
            }
        } else {
            eprintln!("{}", p.phase);
        }
    });
    BUSY.store(false, Ordering::SeqCst);
    let secs = started.elapsed().as_secs();
    Some(match result {
        Ok(dll) => {
            log.line(&format!(
                "OK nach {secs} s: {} (Quelle: {SDK_ZIP_URL}, SDK-Datei: SimConnect SDK\\lib\\SimConnect.dll, SHA-256: {DLL_SHA256}, \
                 Lizenz: {EULA_URL})",
                dll.display()
            ));
            EXIT_OK
        }
        Err(e) => {
            let code = exit_code(e.kind);
            log.line(&format!("FEHLER (Code {code}) nach {secs} s: {e}"));
            code
        }
    })
}

fn exit_code(kind: FailKind) -> i32 {
    match kind {
        FailKind::Network => EXIT_NETWORK,
        FailKind::Checksum => EXIT_CHECKSUM,
        FailKind::Other => EXIT_OTHER,
    }
}

/// A DLL the SimConnect provider would load: the loader's search order
/// (`ffi::candidate_paths`), where the downloaded copy only counts when it matches the pinned
/// hash. The file chosen in Einstellungen → Simulator lives in the logbook database and is not
/// read here (the installer then offers the download once more, which does no harm).
fn usable_dll() -> Option<PathBuf> {
    let downloaded = ffi::downloaded_dll_path();
    crate::find_simconnect_dll_where(&|p| {
        if downloaded.as_deref().is_some_and(|d| d.as_os_str().eq_ignore_ascii_case(p.as_os_str())) {
            verify_file(p, DLL_SIZE, DLL_SHA256).is_ok()
        } else {
            p.is_file()
        }
    })
}

/// Appends timestamped lines to `%LOCALAPPDATA%\io.vectasim.app\logs\simconnect-install.log`
/// and mirrors them on stderr (invisible unless the caller redirects it).
struct CliLog(Option<PathBuf>);

impl CliLog {
    fn open() -> Self {
        let path = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|d| PathBuf::from(d.trim()).join(ffi::APP_LOCAL_DIR).join("logs"))
            .and_then(|dir| std::fs::create_dir_all(&dir).ok().map(|()| dir.join(CLI_LOG_FILE)));
        Self(path)
    }

    fn line(&self, text: &str) {
        let line = format!("[{}] {text}", vectasim_dump::file_stamp(vectasim_core::now_ms()));
        eprintln!("{line}");
        if let Some(path) = &self.0
            && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path)
        {
            let _ = f.write_all(format!("{line}\r\n").as_bytes());
        }
    }
}

/// Removes the scratch folder however `fetch` ends.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Why a download failed – the headless installer mode maps it to its exit code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailKind {
    /// No network, HTTP error, aborted transfer.
    Network,
    /// The SDK ZIP or the DLL inside does not match the pinned size/SHA-256.
    Checksum,
    Other,
}

#[derive(Debug)]
struct FetchError {
    kind: FailKind,
    msg: String,
}

impl FetchError {
    fn new(kind: FailKind, msg: impl Into<String>) -> Self {
        Self { kind, msg: msg.into() }
    }
}

impl From<String> for FetchError {
    fn from(msg: String) -> Self {
        Self::new(FailKind::Other, msg)
    }
}

impl From<&str> for FetchError {
    fn from(msg: &str) -> Self {
        Self::new(FailKind::Other, msg)
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

/// Download, verify and install the DLL; `progress` receives every [`Progress`] step
/// (the Tauri command forwards them as events, the headless mode prints them).
fn fetch(progress: &dyn Fn(Progress)) -> Result<PathBuf, FetchError> {
    let emit = |phase: &'static str, received: u64, total: u64| progress(Progress { phase, received, total });
    if !cfg!(windows) {
        return Err(crate::lang::tr("SimConnect gibt es nur unter Windows.", "SimConnect is only available on Windows.").into());
    }
    let dest = ffi::downloaded_dll_path().ok_or(crate::lang::tr("%LOCALAPPDATA% ist nicht gesetzt", "%LOCALAPPDATA% is not set"))?;
    if verify_file(&dest, DLL_SIZE, DLL_SHA256).is_ok() {
        // already there (and possibly loaded – it could not be replaced anyway)
        emit("done", DLL_SIZE, DLL_SIZE);
        return Ok(dest);
    }
    let dir = dest.parent().ok_or(crate::lang::tr("ungültiger Zielordner", "invalid target folder"))?.to_path_buf();
    let tmp = TempDir(dir.join(".download"));
    let _ = std::fs::remove_dir_all(&tmp.0);
    std::fs::create_dir_all(&tmp.0).map_err(|e| {
        let d = tmp.0.display();
        trf!("Ordner {d} nicht anlegbar: {e}", "Cannot create folder {d}: {e}")
    })?;

    let zip_path = tmp.0.join("sdk.zip");
    download(&|received| emit("download", received, SDK_ZIP_SIZE), &zip_path)?;
    emit("verify", SDK_ZIP_SIZE, SDK_ZIP_SIZE);
    verify_file(&zip_path, SDK_ZIP_SIZE, SDK_ZIP_SHA256)
        .map_err(|e| FetchError::new(FailKind::Checksum, trf!("SDK-Download beschädigt: {e}", "SDK download damaged: {e}")))?;

    emit("extract", SDK_ZIP_SIZE, SDK_ZIP_SIZE);
    install_from_zip(&zip_path, &tmp.0, &dest)?;
    emit("done", SDK_ZIP_SIZE, SDK_ZIP_SIZE);
    Ok(dest)
}

/// Verified SDK ZIP → cabinet → SimConnect.dll (hash-checked) at `dest`, plus `SOURCE.txt`.
fn install_from_zip(zip_path: &Path, tmp: &Path, dest: &Path) -> Result<(), FetchError> {
    let dir = dest.parent().ok_or(crate::lang::tr("ungültiger Zielordner", "invalid target folder"))?;
    let cab = tmp.join("cab1.cab");
    {
        let mut archive = zip::ZipArchive::new(File::open(zip_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut entry = archive.by_name(CAB_ENTRY).map_err(|e| trf!("{CAB_ENTRY} fehlt im SDK-Archiv: {e}", "{CAB_ENTRY} missing from the SDK archive: {e}"))?;
        let mut out = File::create(&cab).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    let out_dir = tmp.join("out");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    expand(&cab, &out_dir)?;
    let extracted = out_dir.join(CAB_FILE_KEY);
    verify_file(&extracted, DLL_SIZE, DLL_SHA256)
        .map_err(|e| FetchError::new(FailKind::Checksum, trf!("SimConnect.dll aus dem SDK passt nicht: {e}", "SimConnect.dll from the SDK does not match: {e}")))?;

    let part = dir.join("SimConnect.dll.part");
    std::fs::copy(&extracted, &part).map_err(|e| e.to_string())?;
    std::fs::rename(&part, dest).map_err(|e| {
        let d = dest.display();
        trf!("{d} nicht schreibbar: {e}", "Cannot write {d}: {e}")
    })?;
    write_source_note(dir);
    Ok(())
}

/// Provenance next to the DLL, so a user (or a Diagnosepaket) can see where it came from.
fn write_source_note(dir: &Path) {
    let note = format!(
        "SimConnect.dll (x64) aus dem Microsoft Flight Simulator SDK {SDK_VERSION} (Core), \
         auf Wunsch des Nutzers von VectaSim heruntergeladen.\r\nQuelle: {SDK_ZIP_URL}\r\n\
         SDK-Datei: SimConnect SDK\\lib\\SimConnect.dll\r\nSHA-256: {DLL_SHA256}\r\n\
         Es gelten die Lizenzbedingungen des MSFS SDK: {EULA_URL}\r\n"
    );
    if let Ok(mut f) = File::create(dir.join("SOURCE.txt")) {
        let _ = f.write_all(note.as_bytes());
    }
}

fn system32(exe: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join(exe)
}

/// Hide the console window of the helper processes.
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// curl.exe arguments: HTTPS only (also on redirects), size cap, and time limits so a
/// stalled connection cannot block the installer forever – abort below 1 KiB/s for 60 s
/// (`--speed-limit`/`--speed-time`), at most 30 min in all (curl exit 28 → network error).
fn curl_args(target: &Path) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = ["--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https"]
        .into_iter()
        .map(Into::into)
        .collect();
    let max_filesize = (SDK_ZIP_SIZE + 1).to_string();
    for x in ["--retry", "2", "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "60", "--max-time", "1800"] {
        a.push(x.into());
    }
    a.extend(["--max-filesize".into(), max_filesize.into(), "--output".into(), target.as_os_str().to_owned(), SDK_ZIP_URL.into()]);
    a
}

/// HTTPS-only download with Windows' own curl.exe (Windows 10 1803+), progress from the file size.
fn download(received_bytes: &dyn Fn(u64), target: &Path) -> Result<(), FetchError> {
    let mut cmd = std::process::Command::new(system32("curl.exe"));
    cmd.args(curl_args(target))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = no_window(&mut cmd).spawn().map_err(|e| trf!("curl.exe nicht startbar: {e}", "Cannot start curl.exe: {e}"))?;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        received_bytes(std::fs::metadata(target).map(|m| m.len()).unwrap_or(0));
        std::thread::sleep(std::time::Duration::from_millis(250));
    };
    if !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        let err = err.trim();
        return Err(FetchError::new(FailKind::Network, trf!("Download fehlgeschlagen ({status}): {err}", "Download failed ({status}): {err}")));
    }
    Ok(())
}

/// Extract one file from a cabinet with Windows' `expand.exe`.
fn expand(cab: &Path, out_dir: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new(system32("expand.exe"));
    cmd.arg(format!("-F:{CAB_FILE_KEY}")).arg(cab).arg(out_dir).stdin(std::process::Stdio::null());
    let out = no_window(&mut cmd).output().map_err(|e| trf!("expand.exe nicht startbar: {e}", "Cannot start expand.exe: {e}"))?;
    if !out.status.success() {
        let (status, text) = (out.status, String::from_utf8_lossy(&out.stdout));
        let text = text.trim();
        return Err(trf!("expand.exe fehlgeschlagen ({status}): {text}", "expand.exe failed ({status}): {text}"));
    }
    Ok(())
}

fn verify_file(path: &Path, size: u64, sha256_hex: &str) -> Result<(), String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len != size {
        return Err(trf!("Größe {len} statt {size} Bytes", "Size {len} instead of {size} bytes"));
    }
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    let got = hex(&h.finish());
    if got != sha256_hex {
        return Err(trf!("SHA-256 {got} statt {sha256_hex}", "SHA-256 {got} instead of {sha256_hex}"));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Minimal streaming SHA-256 (FIPS 180-4), so the check needs no extra crate.
struct Sha256 {
    state: [u32; 8],
    block: [u8; 64],
    filled: usize,
    length: u64,
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19],
            block: [0; 64],
            filled: 0,
            length: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        while !data.is_empty() {
            let take = (64 - self.filled).min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
            if self.filled == 64 {
                let block = self.block;
                self.compress(&block);
                self.filled = 0;
            }
        }
    }

    fn finish(mut self) -> [u8; 32] {
        let bits = self.length.wrapping_mul(8);
        self.update(&[0x80]);
        while self.filled != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        let mut out = [0u8; 32];
        for (chunk, word) in out.as_chunks_mut::<4>().0.iter_mut().zip(self.state) {
            *chunk = word.to_be_bytes();
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for (i, c) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*c);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (s, v) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn curl_has_https_only_and_time_limits() {
        let target = std::path::Path::new(r"C:\Temp\sdk.zip");
        let a: Vec<String> = super::curl_args(target).iter().map(|s| s.to_string_lossy().into_owned()).collect();
        let after = |flag: &str| a.iter().position(|x| x == flag).and_then(|i| a.get(i + 1)).map(String::as_str);
        assert_eq!(after("--proto"), Some("=https"));
        assert_eq!(after("--proto-redir"), Some("=https"));
        assert_eq!(after("--speed-limit"), Some("1024"));
        assert_eq!(after("--speed-time"), Some("60"));
        assert_eq!(after("--max-time"), Some("1800"));
        assert_eq!(after("--connect-timeout"), Some("30"));
        assert_eq!(after("--max-filesize"), Some((super::SDK_ZIP_SIZE + 1).to_string().as_str()));
        assert_eq!(after("--output"), Some(r"C:\Temp\sdk.zip"));
        assert_eq!(a.last().map(String::as_str), Some(super::SDK_ZIP_URL));
    }

    use super::*;

    fn sha(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        hex(&h.finish())
    }

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(sha(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(
            sha(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        let million = vec![b'a'; 1_000_000];
        assert_eq!(sha(&million), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }

    #[test]
    fn sha256_streaming_matches_one_shot() {
        let data: Vec<u8> = (0..10_000u32).map(|i| (i * 31 % 251) as u8).collect();
        let mut h = Sha256::new();
        for chunk in data.chunks(37) {
            h.update(chunk);
        }
        assert_eq!(hex(&h.finish()), sha(&data));
    }

    #[test]
    fn verify_file_checks_size_and_hash() {
        let dir = std::env::temp_dir().join(format!("vectasim-scdl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f.bin");
        std::fs::write(&p, b"abc").unwrap();
        assert!(verify_file(&p, 3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").is_ok());
        assert!(verify_file(&p, 4, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").unwrap_err().contains("Größe"));
        assert!(verify_file(&p, 3, DLL_SHA256).unwrap_err().contains("SHA-256"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End-to-end extraction from a locally downloaded SDK ZIP (108 MB, so not in CI):
    /// `VECTASIM_TEST_SDK_ZIP=<zip> cargo test -p vectasim --lib simconnect_dl -- --ignored`
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn installs_from_the_real_sdk_zip() {
        let zip = PathBuf::from(std::env::var("VECTASIM_TEST_SDK_ZIP").expect("VECTASIM_TEST_SDK_ZIP"));
        verify_file(&zip, SDK_ZIP_SIZE, SDK_ZIP_SHA256).unwrap();
        let root = std::env::temp_dir().join(format!("vectasim-scdl-e2e-{}", std::process::id()));
        let tmp = root.join(".download");
        std::fs::create_dir_all(&tmp).unwrap();
        let dest = root.join("SimConnect.dll");
        install_from_zip(&zip, &tmp, &dest).unwrap();
        verify_file(&dest, DLL_SIZE, DLL_SHA256).unwrap();
        assert!(std::fs::read_to_string(root.join("SOURCE.txt")).unwrap().contains(DLL_SHA256));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cli_mode_only_with_its_flag() {
        let args = |a: &[&str]| a.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
        assert_eq!(run_cli(&args(&["vectasim.exe"])), None);
        assert_eq!(run_cli(&args(&["vectasim.exe", "--minimized"])), None);
        // the program name itself never counts as the flag
        assert_eq!(run_cli(&args(&[CLI_FLAG])), None);
    }

    #[test]
    fn exit_codes_per_failure_kind() {
        assert_eq!(exit_code(FailKind::Network), EXIT_NETWORK);
        assert_eq!(exit_code(FailKind::Checksum), EXIT_CHECKSUM);
        assert_eq!(exit_code(FailKind::Other), EXIT_OTHER);
        assert_eq!(FetchError::from("x").kind, FailKind::Other);
        assert_eq!((EXIT_OK, EXIT_OTHER, EXIT_NETWORK, EXIT_CHECKSUM), (0, 1, 2, 3));
    }

    #[test]
    fn pinned_values_are_consistent() {
        assert!(SDK_ZIP_URL.starts_with("https://sdk.flightsimulator.com/"));
        assert!(SDK_ZIP_URL.contains(SDK_VERSION));
        assert!(CAB_ENTRY.contains(SDK_VERSION));
        for h in [SDK_ZIP_SHA256, DLL_SHA256] {
            assert_eq!(h.len(), 64);
            assert!(h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        }
    }
}
