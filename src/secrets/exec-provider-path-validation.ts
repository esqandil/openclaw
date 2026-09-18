import { FsSafeError } from "../infra/fs-safe.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { isPathInside } from "../infra/path-safety.js";
import { inspectPathPermissions, safeStat } from "../infra/permissions.js";

/** Checks the same command-path trust boundary before validation, writes, and execution.
 * The `fromTrustedPluginIntegration` marker (set exclusively during materialization
 * of trusted bundled/global plugin "${node}" integrations) relaxes the POSIX
 * owner check to also accept uid=0 (root-owned system Node, e.g. /usr/bin/node).
 * Manual exec providers must never carry or trigger this relaxation.
 */
export async function assertSecureExecCommandPath(params: {
  command: string;
  label: string;
  trustedDirs?: string[];
  /**
   * Provenance marker. Only true when the command path was materialized from an
   * active trusted (bundled/global) pluginIntegration secret provider using ${node}.
   * Cannot be supplied by persisted manual config (rejected in CLI validation).
   */
  fromTrustedPluginIntegration?: boolean;
}): Promise<string> {
  const commandPath = resolveUserPath(params.command);
  // resolveUserPath expands and absolutizes nonempty input; the schema rejects relative commands.
  if (!commandPath) {
    throw new Error(`${params.label} must be an absolute path.`);
  }

  const stat = await safeStat(commandPath);
  if (!stat.ok) {
    throw new Error(`${params.label} is not readable: ${commandPath}`);
  }
  if (stat.isDir) {
    throw new Error(`${params.label} must be a file: ${commandPath}`);
  }
  if (stat.isSymlink) {
    throw new Error(`${params.label} must not be a symlink: ${commandPath}`);
  }

  if (params.trustedDirs && params.trustedDirs.length > 0) {
    const trusted = params.trustedDirs.map((entry) => resolveUserPath(entry));
    const inTrustedDir = trusted.some((dir) => isPathInside(dir, commandPath));
    if (!inTrustedDir) {
      throw new Error(`${params.label} is outside trustedDirs: ${commandPath}`);
    }
  }

  const perms = await inspectPathPermissions(commandPath);
  if (!perms.ok) {
    throw new Error(`${params.label} permissions could not be verified: ${commandPath}`);
  }
  if (perms.worldWritable || perms.groupWritable) {
    throw new Error(`${params.label} permissions are too open: ${commandPath}`);
  }

  if (process.platform === "win32" && perms.source === "unknown") {
    // The resolver maps this typed receipt to SECRET_PROVIDER_PATH_SECURITY_UNVERIFIABLE.
    // A plain Error would lose the Windows recovery diagnostic.
    throw new FsSafeError(
      "permission-unverified",
      `${params.label} ACL verification unavailable on Windows for ${commandPath}. Move the command to a path whose ACLs OpenClaw can verify; there is no provider-level bypass.`,
    );
  }

  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      const allowRootForTrusted = params.fromTrustedPluginIntegration === true && stat.uid === 0;
      if (!allowRootForTrusted) {
        throw new Error(
          `${params.label} must be owned by the current user (uid=${uid}): ${commandPath}`,
        );
      }
    }
  }
  return commandPath;
}
