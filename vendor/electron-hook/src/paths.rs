//! Path utilities

fn cache_dir() -> std::path::PathBuf {
    dirs::cache_dir()
        .expect("Failed to get cache directory")
        .join("electron-hook")
}

fn asar_cache_dir() -> std::path::PathBuf {
    ensure_dir(cache_dir().join("asar"))
}

/// The path to a specific .asar file
pub fn asar_cache_path(asar_id: &str) -> std::path::PathBuf {
    asar_cache_dir().join(format!("{asar_id}.asar"))
}

fn mod_artifacts_dir() -> std::path::PathBuf {
    ensure_dir(cache_dir().join("mods"))
}

/// The path to a specific mod artifact folder
pub fn mod_artifact_dir(mod_name: &str) -> std::path::PathBuf {
    mod_artifacts_dir().join(mod_name)
}

fn data_dir() -> std::path::PathBuf {
    dirs::data_dir()
        .expect("Failed to get data directory")
        .join("electron-hook")
}

fn data_profiles_dir() -> std::path::PathBuf {
    ensure_dir(data_dir().join("profiles"))
}

/// The path to a specific profile directory
pub fn data_profile_dir(profile_id: &str) -> std::path::PathBuf {
    data_profiles_dir().join(profile_id)
}

/// Ensure a directory exists, recursively creating it if it doesn't
pub fn ensure_dir(path: std::path::PathBuf) -> std::path::PathBuf {
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("Failed to create directory: {e}"))
            .unwrap();
    }
    path
}

pub(crate) fn redirect_asar_path(
    path: &str,
    custom_asar: &str,
    app_folder: Option<&str>,
) -> Option<String> {
    for sep in ['/', '\\'] {
        let original = format!("resources{sep}_app.asar");
        if path.contains(&original) {
            return Some(path.replace(&format!("{sep}_app.asar"), &format!("{sep}app.asar")));
        }
    }

    for sep in ['/', '\\'] {
        let needle = match app_folder {
            Some(folder) => format!("{folder}{sep}resources{sep}app.asar"),
            None => format!("resources{sep}app.asar"),
        };
        if path.contains(&needle) {
            return Some(custom_asar.to_string());
        }
    }

    None
}

/// We don't want to proxy when the updater is running.
pub(crate) fn should_proxy_open(flags: i32) -> bool {
    flags & libc::O_CREAT == 0
}

#[cfg(test)]
mod tests {
    use super::{redirect_asar_path, should_proxy_open};

    #[test]
    fn writes_are_never_proxied() {
        assert!(!should_proxy_open(libc::O_CREAT));
        assert!(!should_proxy_open(libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY));
        assert!(!should_proxy_open(libc::O_CREAT | libc::O_TRUNC));
    }

    #[test]
    fn reads_are_proxied() {
        assert!(should_proxy_open(libc::O_RDONLY));
        // NOTE(tronhawk): removed the `libc::O_CLOEXEC` assertion — it is a Unix-only
        // constant that does not exist on Windows `libc`.
        assert!(should_proxy_open(libc::O_RDWR));
    }

    #[test]
    fn maps_original_asar_back_to_app_asar() {
        assert_eq!(
            redirect_asar_path("/opt/Discord/resources/_app.asar", "/tmp/mod.asar", None),
            Some("/opt/Discord/resources/app.asar".to_string())
        );
        assert_eq!(
            redirect_asar_path(
                "C:\\Users\\me\\Discord\\resources\\_app.asar",
                "C:\\tmp\\mod.asar",
                None
            ),
            Some("C:\\Users\\me\\Discord\\resources\\app.asar".to_string())
        );
    }

    #[test]
    fn maps_app_asar_to_custom_asar() {
        assert_eq!(
            redirect_asar_path("/opt/Discord/resources/app.asar", "/tmp/mod.asar", None),
            Some("/tmp/mod.asar".to_string())
        );
        assert_eq!(
            redirect_asar_path(
                "C:\\Users\\me\\Discord\\app-1.2.3\\resources\\app.asar",
                "C:\\tmp\\mod.asar",
                Some("app-1.2.3")
            ),
            Some("C:\\tmp\\mod.asar".to_string())
        );
    }

    #[test]
    fn windows_app_folder_restricts_the_redirect() {
        assert_eq!(
            redirect_asar_path(
                "C:\\Users\\me\\Discord\\app-9.9.9\\resources\\app.asar",
                "C:\\tmp\\mod.asar",
                Some("app-1.2.3")
            ),
            None
        );
    }

    #[test]
    fn app_folder_scopes_redirect_on_linux() {
        // The running app's own folder is redirected…
        assert_eq!(
            redirect_asar_path(
                "/home/u/.config/discordcanary/app-1.0.1599/resources/app.asar",
                "/tmp/mod.asar",
                Some("app-1.0.1599")
            ),
            Some("/tmp/mod.asar".to_string())
        );

        // …but a new folder being written by the auto-updater is not.
        assert_eq!(
            redirect_asar_path(
                "/home/u/.config/discordcanary/app-1.0.1626/resources/app.asar",
                "/tmp/mod.asar",
                Some("app-1.0.1599")
            ),
            None
        );
    }

    #[test]
    fn unrelated_paths_are_untouched() {
        assert_eq!(
            redirect_asar_path("/opt/Discord/resources/asar", "/tmp/mod.asar", None),
            None
        );
        assert_eq!(redirect_asar_path("/etc/hosts", "/tmp/mod.asar", None), None);
    }

    #[test]
    fn _app_asar_takes_precedence_over_app_asar() {
        assert_eq!(
            redirect_asar_path(
                "/opt/Discord/resources/_app.asar",
                "/tmp/mod.asar",
                None
            ),
            Some("/opt/Discord/resources/app.asar".to_string())
        );
    }
}
