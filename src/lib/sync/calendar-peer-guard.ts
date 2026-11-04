import { manifestProblem } from "./engine-gates";
import { PUBLISH_HEARTBEAT_MS } from "./engine-publish";
import type { PeerManifest } from "./transport";

const DAY_MS = 24 * 60 * 60_000;

/**
 * A manifest is rewritten when one of its domains changes or by the heartbeat, so an idle peer
 * legitimately keeps an old `writtenAt`; a pull cannot refresh it. Calendar changes force a
 * publication, so an old manifest still reports the calendar setting accurately. Only one older
 * than the heartbeat (plus the day its check runs on) proves the peer has not been online.
 */
export const CALENDAR_PEER_MAX_AGE_MS = PUBLISH_HEARTBEAT_MS + DAY_MS;

/** A peer's missing, invalid, future-dated or unmaintained manifest cannot prove its reconciler is off. */
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
    if (age < -5 * 60_000 || age > CALENDAR_PEER_MAX_AGE_MS)
      return `L’état du calendrier de ${name} est ancien ou inconnu. Synchronisez cet ordinateur avant de continuer.`;
  }
  const missing = known.find((peer) => !peers.some((item) => item.deviceId === peer.peerId));
  return missing
    ? `Impossible de vérifier ${missing.peerName || missing.peerId}. Synchronisez cet ordinateur avant de continuer.`
    : null;
};
