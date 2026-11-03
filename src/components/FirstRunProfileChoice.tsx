import type { DeviceProfile } from "../lib/sync/profile";

/** Runs before the application shell and its background jobs are mounted. */
export const FirstRunProfileChoice = ({
  choose,
  error,
  busy,
  workSelectable,
  onJoin,
}: {
  choose: (profile: DeviceProfile) => Promise<boolean>;
  error: string | null;
  busy: boolean;
  workSelectable: boolean;
  onJoin: () => void;
}) => (
  <div className="splash">
    <div className="splash__panel">
      <p className="eyebrow">TrackDidia</p>
      <h1>Comment utiliser cet ordinateur ?</h1>
      <p>Choisis un profil avant de créer des données sur cet ordinateur.</p>
      <button type="button" disabled={busy} onClick={() => void choose("personal")}>
        Ordinateur personnel
      </button>{" "}
      <button type="button" disabled={busy || !workSelectable} onClick={() => void choose("work")}>
        Ordinateur professionnel
      </button>
      {!workSelectable && (
        <p>Le profil professionnel sera disponible dans une prochaine version.</p>
      )}
      <p>Tu peux aussi configurer la synchronisation dans les paramètres.</p>
      <button type="button" disabled={busy} onClick={onJoin}>
        Configurer la synchronisation
      </button>
      {error && <p role="alert">Impossible d’enregistrer le choix : {error}. Réessaie.</p>}
    </div>
  </div>
);
