import test from "node:test";
import assert from "node:assert";
import fs from "fs";
import { AEADStorageAdapter } from "../../persistence/aead-storage-adapter.mjs";
import { SecurityState } from "../../state-machine/states.mjs";
import { setupDb } from "./_harness/db.mjs";

test("Snapshot Rollback Testing", async (t) => {
  await t.test("Physical database rollback is detected cryptographically", async () => {
    const dbPath = "./test/databases/test-snapshot-rollback.db";
    const absolutePath = await setupDb(dbPath);
    await AEADStorageAdapter.initDatabase(absolutePath);
    const backupPath = absolutePath + ".backup";

    // State A
    const stateA = {
      state: SecurityState.AUTHENTICATED,
      session: { status: "AUTHENTICATED" }
    };
    await AEADStorageAdapter.commitTransitionWithOCC(0, stateA, "BOOT");
    
    // Backup State A
    fs.copyFileSync(absolutePath, backupPath);

    // State B (Revoked)
    const stateB = {
      state: SecurityState.REVOKED,
      session: { status: "REVOKED" }
    };
    await AEADStorageAdapter.commitTransitionWithOCC(1, stateB, "REVOKE");
    
    // Overwrite DB with State A backup
    fs.copyFileSync(backupPath, absolutePath);

    // Read state - Should throw SECURITY_STATE_UNCERTAIN
    await assert.rejects(
      async () => {
        await AEADStorageAdapter.getSecurityStateRow();
      },
      (err) => {
        return err.message.includes("SECURITY_STATE_UNCERTAIN");
      },
      "System must throw SECURITY_STATE_UNCERTAIN when reading a rolled-back database"
    );
    
    // Cleanup
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  });
});
