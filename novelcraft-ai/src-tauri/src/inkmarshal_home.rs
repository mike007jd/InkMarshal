use std::path::PathBuf;

pub(crate) const INKMARSHAL_HOME_DIR: &str = ".inkmarshal";
pub(crate) const INKMARSHAL_APP_DIR: &str = "app";

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn absolutize_with(path: PathBuf, current_dir: &std::path::Path) -> PathBuf {
    if path.is_absolute() {
        return path;
    }
    current_dir.join(path)
}

fn expand_home(raw: &str, home_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    if raw == "~" {
        return home_dir.map(PathBuf::from);
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home_dir.map(|home| home.join(rest));
    }
    Some(PathBuf::from(raw))
}

fn inkmarshal_home_dir_from_parts(
    home_dir: Option<&std::path::Path>,
    override_raw: Option<&str>,
    current_dir: &std::path::Path,
) -> Option<PathBuf> {
    if let Some(raw) = override_raw {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return expand_home(trimmed, home_dir).map(|path| absolutize_with(path, current_dir));
        }
    }
    home_dir.map(|home| home.join(INKMARSHAL_HOME_DIR))
}

pub(crate) fn inkmarshal_home_dir() -> Option<PathBuf> {
    let home = user_home_dir();
    let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    inkmarshal_home_dir_from_parts(
        home.as_deref(),
        std::env::var("INKMARSHAL_HOME").ok().as_deref(),
        &current,
    )
}

pub(crate) fn inkmarshal_app_dir() -> Result<PathBuf, String> {
    inkmarshal_home_dir()
        .map(|home| home.join(INKMARSHAL_APP_DIR))
        .ok_or_else(|| "Cannot resolve InkMarshal home directory".to_string())
}

pub(crate) fn inkmarshal_log_dir() -> Result<PathBuf, String> {
    Ok(inkmarshal_app_dir()?.join("logs"))
}

#[cfg(test)]
mod tests {
    use super::{inkmarshal_home_dir_from_parts, INKMARSHAL_APP_DIR, INKMARSHAL_HOME_DIR};
    use std::path::Path;

    #[test]
    fn constants_lock_home_layout() {
        assert_eq!(INKMARSHAL_HOME_DIR, ".inkmarshal");
        assert_eq!(INKMARSHAL_APP_DIR, "app");
    }

    #[test]
    fn home_dir_defaults_to_hidden_inkmarshal_dir() {
        assert_eq!(
            inkmarshal_home_dir_from_parts(
                Some(Path::new("/Users/tester")),
                None,
                Path::new("/repo")
            )
            .unwrap(),
            Path::new("/Users/tester").join(".inkmarshal")
        );
    }

    #[test]
    fn home_dir_honors_tilde_and_relative_overrides() {
        assert_eq!(
            inkmarshal_home_dir_from_parts(
                Some(Path::new("/Users/tester")),
                Some("~/InkHome"),
                Path::new("/repo")
            )
            .unwrap(),
            Path::new("/Users/tester").join("InkHome")
        );
        assert_eq!(
            inkmarshal_home_dir_from_parts(
                Some(Path::new("/Users/tester")),
                Some("relative-home"),
                Path::new("/repo")
            )
            .unwrap(),
            Path::new("/repo").join("relative-home")
        );
    }
}
