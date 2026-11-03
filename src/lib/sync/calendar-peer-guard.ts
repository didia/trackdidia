import { manifestProblem } from "./engine-gates";
import type { PeerManifest } from "./transport";

/** A peer's old or missing manifest cannot prove its calendar reconciler is off. */
export const calendarPeerWarning = (
  peers: PeerManifest[],
  known: { peerId: string; peerName: string }[],
  now: number,
): string | null => {
  for (const peer of peers) {
    const name = peer.deviceName || peer.deviceId || "un autre ordinateur";
    if (manifestProblem(peer))
      return `L’état du calendrier de ${name} est invalide. Synchronisez cet ordinateur avant de continuer.`;
    if (peer.calendarSyncEnabled)
      return `La synchronisation du calendrier est active sur ${name}. Désactivez-la sur cet ordinateur et synchronisez-le avant de continuer.`;
    const age = now - Date.parse(peer.writtenAt);
    if (age < -5 * 60_000 || age > 24 * 60 * 60_000)
      return `L’état du calendrier de ${name} est ancien ou inconnu. Synchronisez cet ordinateur avant de continuer.`;
  }
  const missing = known.find((peer) => !peers.some((item) => item.deviceId === peer.peerId));
  return missing
    ? `Impossible de vérifier ${missing.peerName || missing.peerId}. Synchronisez cet ordinateur avant de continuer.`
    : null;
};
