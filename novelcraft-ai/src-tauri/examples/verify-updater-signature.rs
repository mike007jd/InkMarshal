use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, process};

fn decode_wrapped(value: &str, label: &str) -> String {
    let bytes = STANDARD
        .decode(value.trim())
        .unwrap_or_else(|error| panic!("invalid base64 {label}: {error}"));
    String::from_utf8(bytes).unwrap_or_else(|error| panic!("invalid UTF-8 {label}: {error}"))
}

fn main() {
    let mut args = env::args().skip(1);
    let archive_path = args.next().unwrap_or_default();
    let signature_path = args.next().unwrap_or_default();
    let public_key_base64 = args.next().unwrap_or_default();
    if archive_path.is_empty()
        || signature_path.is_empty()
        || public_key_base64.is_empty()
        || args.next().is_some()
    {
        eprintln!("usage: verify-updater-signature <archive> <signature-file> <public-key-base64>");
        process::exit(2);
    }

    let archive = fs::read(&archive_path)
        .unwrap_or_else(|error| panic!("could not read updater archive: {error}"));
    let signature_base64 = fs::read_to_string(&signature_path)
        .unwrap_or_else(|error| panic!("could not read updater signature: {error}"));
    let public_key = PublicKey::decode(&decode_wrapped(&public_key_base64, "public key"))
        .unwrap_or_else(|error| panic!("invalid updater public key: {error}"));
    let signature = Signature::decode(&decode_wrapped(&signature_base64, "signature"))
        .unwrap_or_else(|error| panic!("invalid updater signature: {error}"));
    public_key
        .verify(&archive, &signature, true)
        .unwrap_or_else(|error| panic!("updater signature verification failed: {error}"));
    println!("Updater signature verified.");
}
