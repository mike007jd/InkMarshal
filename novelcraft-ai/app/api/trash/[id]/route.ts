import { NextResponse } from 'next/server';

import { deleteTrashedNovelPermanently } from '@/lib/db';
import { getNovelVault, isVaultPathReferencedElsewhere } from '@/lib/db/queries-vault';
import { requireTrashedNovelOwner } from '@/lib/local-auth';
import {
  discardAppOwnedVaultQuarantine,
  quarantineAppOwnedNovelVault,
  restoreAppOwnedVaultQuarantine,
} from '@/lib/vault/app-owned-cleanup';

export const runtime = 'nodejs';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireTrashedNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const vault = await getNovelVault(id);
  const sharedVault = vault?.vaultPath
    ? await isVaultPathReferencedElsewhere(id, vault.vaultPath)
    : false;
  const vaultQuarantine = sharedVault
    ? null
    : quarantineAppOwnedNovelVault(vault?.vaultPath, id);
  let deleted = false;
  try {
    deleted = await deleteTrashedNovelPermanently(id, ownerCheck.user.id);
  } catch (error) {
    restoreAppOwnedVaultQuarantine(vaultQuarantine);
    throw error;
  }
  if (!deleted) restoreAppOwnedVaultQuarantine(vaultQuarantine);
  if (!deleted) return NextResponse.json({ error: 'Permanent delete failed' }, { status: 409 });
  try {
    discardAppOwnedVaultQuarantine(vaultQuarantine);
  } catch (error) {
    console.warn('[trash] database deletion succeeded but Vault cleanup did not', error);
  }
  return NextResponse.json({ ok: true });
}
