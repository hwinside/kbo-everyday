import { readRankPlayerId } from "./rank-request-context";
import { resolvePlayerIdentity } from "../../utils/resolve-player";

/** Display-name compatibility only after canonical ID is fixed. Complete roster
 * tokens (including a given name) are allowed here, never for player discovery. */
export function recordPlayerNamesMatch(playerId: string, servedName: string, requestedName: string): boolean {
  if (servedName === requestedName) return true;
  if (!/^[A-Z]{2}\d{3}$/.test(playerId) || /[\r\n<>]/.test(requestedName)) return false;
  const identity = resolvePlayerIdentity(playerId);
  if (!identity || readRankPlayerId(identity.kboId) !== playerId) return false;
  const normalize = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ");
  const canonicalName = normalize(identity.name);
  const matches = (name: string) => {
    const normalized = normalize(name);
    return normalized === canonicalName || (normalized.length > 0
      && !normalized.includes(" ") && canonicalName.split(" ").includes(normalized));
  };
  return matches(servedName) && matches(requestedName);
}
