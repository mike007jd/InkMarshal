const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
export const MAX_VAULT_PATH_LENGTH = 4_096;
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateVaultPathInput(vaultPath: unknown): string {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('Vault path must be absolute');
  }
  if (vaultPath.length > MAX_VAULT_PATH_LENGTH || CONTROL_CHARS.test(vaultPath)) {
    throw new Error('Vault path is invalid');
  }
  if (!vaultPath.startsWith('/') && !WINDOWS_ABSOLUTE_PATH.test(vaultPath)) {
    throw new Error('Vault path must be absolute');
  }
  return vaultPath;
}
