import { fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { defaultAppSettings } from "../domain/settings";
import type { PeerState, SyncIssueCode } from "../lib/sync/engine-types";
import {
  issue,
  peer,
  publishReport,
  pullReport,
  status,
  syncController,
} from "../test/sync-fixtures";
import { renderWithApp } from "../test/test-utils";
import { SyncPage } from "./SyncPage";

const enabledSettings = () => ({ ...defaultAppSettings(), multiDeviceSyncEnabled: true });

const renderPage = (controller = syncController(), overrides: Record<string, unknown> = {}) =>
  renderWithApp(
    <Routes>
      <Route path="/sync" element={<SyncPage />} />
      <Route path="/parametres" element={<p>page parametres</p>} />
    </Routes>,
    {
      route: "/sync",
      contextOverrides: {
        browserPreview: false,
        debugEnabled: true,
        settings: enabledSettings(),
        sync: controller,
        ...overrides,
      },
    },
  );

describe("SyncPage gates", () => {
  it("says it is unavailable in browser preview and touches nothing", async () => {
    const sync = syncController({ supported: false });
    await renderPage(sync, { browserPreview: true });
    expect(screen.getByText(/Indisponible en mode aperçu navigateur/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Synchroniser maintenant" })).toBeNull();
    expect(sync.refresh).not.toHaveBeenCalled();
  });

  it("is a gate message without debug mode, even when sync is enabled", async () => {
    const sync = syncController();
    await renderPage(sync, { debugEnabled: false });
    expect(
      screen.getByText("Cette page expérimentale n'est disponible qu'en mode debug."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Synchroniser maintenant" })).toBeNull();
    expect(sync.refresh).not.toHaveBeenCalled();
  });

  it("is a gate message with a link to Settings while sync is not enabled", async () => {
    const sync = syncController();
    await renderPage(sync, { settings: defaultAppSettings() });
    expect(screen.getByText(/La synchronisation n'est pas activée/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Synchroniser maintenant" })).toBeNull();
    expect(sync.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Ouvrir les Paramètres" }));
    expect(screen.getByText("page parametres")).toBeInTheDocument();
  });

  it("loads its state on open", async () => {
    const sync = syncController();
    await renderPage(sync);
    expect(sync.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("SyncPage while the capture backfill is unfinished", () => {
  const unfinished = () =>
    status({
      ready: false,
      backfill: {
        complete: false,
        progress: {
          pass: 1,
          scannedRows: 30,
          totalRows: 100,
          stamped: 12,
          startedAt: "2026-10-27T12:00:00.000Z",
        },
      },
    });

  it("explains that sync is paused, shows the percentage and resumes on request", async () => {
    const sync = syncController({ status: unfinished() });
    await renderPage(sync);
    const banner = screen.getByText("Initialisation du suivi des changements").closest(".banner");
    expect(banner).toHaveTextContent("(30 %)");
    expect(banner).toHaveTextContent("La synchronisation reste en pause");
    // The generic "not ready" message would be misleading here.
    expect(screen.queryByText(/identité ou suivi des changements manquant/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reprendre l'initialisation" }));
    expect(sync.resumeBackfill).toHaveBeenCalledTimes(1);
  });

  it("prefers the live percentage of a running resume and disables the button while busy", async () => {
    await renderPage(
      syncController({
        status: unfinished(),
        phase: "resuming",
        backfill: { percent: 77, scannedRows: 77, totalRows: 100 },
      }),
    );
    expect(screen.getByText(/\(77 %\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reprise de l'initialisation…" })).toBeDisabled();
  });

  it("shows no backfill banner once it is complete", async () => {
    await renderPage(syncController({ status: status() }));
    expect(screen.queryByText("Initialisation du suivi des changements")).toBeNull();
  });
});

describe("SyncPage chunked merges", () => {
  const runWith = (domains: never[]) => ({
    finishedAtMs: Date.UTC(2026, 9, 27, 12, 0, 6),
    error: null,
    report: {
      pull: pullReport({
        peers: [
          {
            peerId: "dev:00000000-0000-4000-8000-000000000002",
            peerName: "Portable bureau",
            transport: "folder:personal",
            status: "ok",
            domains,
          },
        ],
      }),
      publish: publishReport(),
    },
  });

  it("says how many steps a large bundle took, and where a cut one stopped", async () => {
    const domains = [
      { domain: "finance", outcome: "applied", chunks: { total: 12, applied: 12, maxMs: 188 } },
      { domain: "gtd", outcome: "deferred", chunks: { total: 9, applied: 3, maxMs: 40 } },
    ] as never[];
    await renderPage(syncController({ status: status(), run: runWith(domains) }));
    expect(screen.getByText(/fusion en 12 étapes \(la plus longue : 188 ms\)/)).toBeInTheDocument();
    expect(screen.getByText(/fusion interrompue après 3 étapes sur 9/)).toBeInTheDocument();
  });

  it("says nothing about steps for a bundle applied in one piece", async () => {
    const domains = [{ domain: "gtd", outcome: "applied" }] as never[];
    await renderPage(syncController({ status: status(), run: runWith(domains) }));
    expect(screen.queryByText(/fusion en/)).toBeNull();
  });
});

describe("SyncPage states", () => {
  it("shows a loading state while the first status is read", async () => {
    await renderPage(syncController({ phase: "checking", status: null }));
    expect(screen.getByText("Chargement de l'état de la synchronisation…")).toBeInTheDocument();
  });

  it("shows the empty state, the pending count and no peers table", async () => {
    await renderPage(syncController({ status: status({ pendingChanges: 3 }) }));
    expect(screen.getByText("3 changements en attente de publication")).toBeInTheDocument();
    expect(screen.getByText(/Aucun autre ordinateur détecté/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByText("Aucune synchronisation lancée depuis le démarrage de l'application."),
    ).toBeInTheDocument();
  });

  it("says when nothing is pending", async () => {
    await renderPage(syncController({ status: status() }));
    expect(screen.getByText("Aucun changement en attente de publication")).toBeInTheDocument();
  });

  it("warns when sync is not ready on this device", async () => {
    await renderPage(syncController({ status: status({ ready: false }) }));
    expect(screen.getByText(/n'est pas prête sur cet ordinateur/)).toBeInTheDocument();
  });

  it("lists peers with name, last sync, versions, profile and state", async () => {
    await renderPage(
      syncController({
        status: status({
          peers: [
            peer(),
            peer({
              peerId: "dev:00000000-0000-4000-8000-000000000003",
              peerName: "Vieux Mac",
              state: "update_required",
              message: "Update TrackDidia to sync with Vieux Mac",
              schemaVersion: 99,
              appVersion: "9.9.9",
              lastSyncedAt: null,
            }),
          ],
        }),
      }),
    );
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("Portable bureau")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("0.2.0 / v43")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("À jour")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Mise à jour requise")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Jamais")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("9.9.9 / v99")).toBeInTheDocument();
  });

  it("shows a setup error as an alert", async () => {
    await renderPage(
      syncController({
        status: null,
        setupError: { code: "folder_rejected", message: "role_mismatch", role: "gtd" },
      }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Dossier GTD partagé");
    expect(alert).toHaveTextContent("Ce dossier est refusé");
  });

  it("lists the files a folder listing ignored", async () => {
    await renderPage(
      syncController({
        status: status({ peers: [peer()] }),
        ignored: [
          {
            transport: "folder:gtd",
            entries: [{ path: "dev-x/manifest (1).json", reason: "conflict_copy" }],
          },
        ],
      }),
    );
    expect(screen.getByText("dev-x/manifest (1).json")).toBeInTheDocument();
    expect(screen.getByText(/dossier GTD partagé — 1/)).toBeInTheDocument();
  });
});

describe("Sync now", () => {
  it("calls the controller and is disabled while a run is in progress", async () => {
    const sync = syncController({ status: status() });
    const view = await renderPage(sync);
    fireEvent.click(screen.getByRole("button", { name: "Synchroniser maintenant" }));
    expect(sync.syncNow).toHaveBeenCalledTimes(1);
    view.unmount();

    await renderPage(syncController({ phase: "syncing", status: status() }));
    const running = screen.getByRole("button", { name: "Synchronisation…" });
    expect(running).toBeDisabled();
    expect(screen.getByRole("button", { name: "Actualiser l'état" })).toBeDisabled();
  });

  it("renders what a run did: totals, the safety backup, skipped peers and published domains", async () => {
    const run = {
      finishedAtMs: Date.UTC(2026, 9, 27, 12, 0, 6),
      error: null,
      report: {
        pull: pullReport({
          totals: {
            bundlesApplied: 2,
            applied: 120,
            skipped: 30,
            tombstonesApplied: 4,
            conflictsLogged: 1,
            chunksApplied: 2,
            maxChunkMs: 5,
          },
          safetyBackup: {
            reasons: ["first_merge"],
            status: "taken",
            path: "/Drive/Perso/backups/trackdidia-auto-backup-3f1c0b9c-2026.db",
          },
          peers: [
            {
              peerId: "dev:00000000-0000-4000-8000-000000000003",
              peerName: "Vieux Mac",
              transport: "folder:gtd",
              status: "update_required",
              domains: [],
            },
            {
              peerId: "dev:00000000-0000-4000-8000-000000000004",
              peerName: "Ancien PC",
              transport: "folder:gtd",
              status: "stale",
              domains: [],
            },
            {
              peerId: "dev:00000000-0000-4000-8000-000000000002",
              peerName: "Portable bureau",
              transport: "folder:gtd",
              status: "ok",
              clockSkewMs: 600_000,
              domains: [],
            },
          ],
        }),
        publish: publishReport({
          domains: [
            { domain: "gtd", outcome: "published", transport: "folder:gtd", generation: 7 },
            { domain: "personal", outcome: "clean", transport: "folder:personal" },
            { domain: "finance", outcome: "failed", transport: "folder:personal" },
          ],
        }),
      },
    };
    await renderPage(syncController({ status: status(), run }));
    expect(
      screen.getByText(
        "2 paquet(s) appliqué(s) · 120 élément(s) mis à jour · 30 déjà à jour · 4 suppression(s) · 1 conflit(s) enregistré(s)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Faite avant la première fusion : \/Drive\/Perso\/backups\/trackdidia-auto-backup-3f1c0b9c/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Vieux Mac : mets à jour TrackDidia pour synchroniser avec cet ordinateur."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ancien PC : hors ligne trop longtemps/)).toBeInTheDocument();
    expect(screen.getByText(/L'horloge de Portable bureau est en avance/)).toBeInTheDocument();
    expect(screen.getByText("GTD : publié (génération 7)")).toBeInTheDocument();
    expect(screen.getByText("Personnel : inchangé")).toBeInTheDocument();
    expect(screen.getByText("Finances : échec")).toBeInTheDocument();
  });

  it("says when the safety backup could not be made and nothing was merged", async () => {
    const run = {
      finishedAtMs: Date.now(),
      error: null,
      report: {
        pull: pullReport({
          complete: false,
          remaining: [{ transport: "folder:gtd", domain: "gtd", peerId: "x", peerName: "X" }],
          safetyBackup: { reasons: ["first_merge"], status: "failed" },
          issues: [
            issue({
              severity: "error",
              code: "safety_backup_required",
              message: "A backup of this laptop is required before merging",
              transport: undefined,
            }),
          ],
        }),
        publish: publishReport(),
      },
    };
    await renderPage(syncController({ status: status(), run }));
    expect(screen.getByText("Impossible de la faire : rien n'a été fusionné.")).toBeInTheDocument();
    expect(screen.getByText(/Réception incomplète : 1 élément/)).toBeInTheDocument();
    expect(screen.getByText(/Une sauvegarde de cet ordinateur est requise/)).toBeInTheDocument();
  });

  it("renders a run that failed before it produced a report", async () => {
    await renderPage(
      syncController({
        status: status(),
        run: {
          finishedAtMs: Date.now(),
          report: null,
          error: { code: "already_running", message: "A pull is already running" },
        },
      }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("La synchronisation a échoué");
    // The French copy for the code, not the engine's English message.
    expect(alert).toHaveTextContent("Une synchronisation est déjà en cours.");
    expect(alert).not.toHaveTextContent("A pull is already running");
  });
});

describe("issues", () => {
  it("shows a configuration error prominently, with advice not to retry", async () => {
    await renderPage(
      syncController({
        status: status({
          issues: [
            issue({
              severity: "error",
              code: "transport_failed",
              detail: "configuration",
              message: "Listing: role_mismatch happened. Choose another folder in Settings",
            }),
          ],
        }),
      }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Dossier mal configuré");
    expect(alert).toHaveTextContent("réessayer ne servira à rien");
    expect(alert).toHaveTextContent("dossier GTD partagé");
  });

  it("shows too_large as a persistent error, not as a retry hint", async () => {
    await renderPage(
      syncController({
        status: status({
          issues: [
            issue({
              severity: "error",
              code: "publish_failed",
              detail: "too_large",
              domain: "finance",
              transport: "folder:personal",
              message: "Publishing the finance data failed",
            }),
          ],
        }),
      }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Données trop volumineuses");
    expect(alert).toHaveTextContent("L'erreur est persistante");
    expect(alert).toHaveTextContent("dossier personnel");
  });

  it("shows an unreachable folder as a calm warning, not an alert", async () => {
    await renderPage(syncController({ status: status({ issues: [issue()] }) }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/est inaccessible \(Google Drive monté \?\)/)).toBeInTheDocument();
    expect(screen.getByText("Avertissement")).toBeInTheDocument();
  });

  it('tells a folder that was never prepared to use "Revérifier les dossiers", not that Drive is unmounted', async () => {
    await renderPage(
      syncController({
        status: status({
          issues: [
            issue({
              detail: "folder_not_prepared",
              transport: "folder:personal",
              message: "Listing: not prepared",
            }),
          ],
        }),
      }),
    );
    expect(screen.getByText(/Revérifier les dossiers/)).toBeInTheDocument();
    expect(screen.queryByText(/Google Drive monté/)).toBeNull();
  });

  it("keeps the engine's technical message available underneath", async () => {
    await renderPage(syncController({ status: status({ issues: [issue()] }) }));
    expect(screen.getByText(/the folder cannot be reached/)).toBeInTheDocument();
  });
});

describe("stale peers", () => {
  const stale = status({
    peers: [
      peer({
        peerId: "dev:00000000-0000-4000-8000-000000000004",
        peerName: "Ancien PC",
        state: "stale",
        message: "offline too long",
      }),
    ],
  });

  it("needs a second click to approve a stale peer, and approves exactly that peer", async () => {
    const sync = syncController({ status: stale });
    await renderPage(sync);
    expect(screen.getByText(/Ancien PC est resté hors ligne trop longtemps/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fusionner quand même Ancien PC" }));
    expect(sync.syncNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmer la fusion de Ancien PC" }));
    expect(sync.syncNow).toHaveBeenCalledWith({
      approveStalePeers: ["dev:00000000-0000-4000-8000-000000000004"],
    });
  });

  it("can be cancelled without merging", async () => {
    const sync = syncController({ status: stale });
    await renderPage(sync);
    fireEvent.click(screen.getByRole("button", { name: "Fusionner quand même Ancien PC" }));
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(sync.syncNow).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Fusionner quand même Ancien PC" }),
    ).toBeInTheDocument();
  });

  it("offers no approval for a peer that is not stale", async () => {
    await renderPage(syncController({ status: status({ peers: [peer()] }) }));
    expect(screen.queryByRole("button", { name: /Fusionner quand même/ })).toBeNull();
  });
});

// Both records are exhaustive by type: adding an issue code or a peer state to the engine makes this
// file stop compiling until the page has copy for it (and the tests below render it).
const ALL_ISSUE_CODES: Record<SyncIssueCode, true> = {
  sync_not_ready: true,
  backfill_incomplete: true,
  transport_unreachable: true,
  transport_timeout: true,
  transport_failed: true,
  transport_ignored: true,
  manifest_invalid: true,
  format_version_unsupported: true,
  update_required: true,
  stale_peer: true,
  clock_skew: true,
  domain_not_allowed: true,
  wrong_domain_bundle: true,
  bundle_device_mismatch: true,
  bundle_not_ready: true,
  bundle_invalid: true,
  bundle_rejected: true,
  bundle_failed: true,
  bookkeeping_failed: true,
  safety_backup_required: true,
  publish_failed: true,
  publish_skipped: true,
  pending_unpublished_domain: true,
};
const ALL_PEER_STATES: Record<PeerState, true> = {
  synced: true,
  update_required: true,
  stale: true,
  format_unsupported: true,
  invalid_manifest: true,
  not_ready: true,
  pending: true,
  error: true,
  unreachable: true,
  unknown: true,
};

describe("every issue code and peer state has French copy", () => {
  it("renders every issue code without a missing translation key", async () => {
    const issues = (Object.keys(ALL_ISSUE_CODES) as SyncIssueCode[]).map((code) =>
      issue({
        code,
        severity: "warning",
        peerName: "Pair",
        domain: "gtd",
        message: `engine message for ${code}`,
        detail: code === "pending_unpublished_domain" ? "personal,finance" : undefined,
      }),
    );
    await renderPage(syncController({ status: status({ issues }) }));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/page\.issues\.|page\.peerState\.|page\.peers\./);
    expect(screen.getAllByText("Avertissement")).toHaveLength(issues.length);
  });

  it("renders every peer state with its label", async () => {
    const states = Object.keys(ALL_PEER_STATES) as PeerState[];
    await renderPage(
      syncController({
        status: status({
          peers: states.map((state, index) =>
            peer({
              peerId: `dev:00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
              peerName: `Pair ${state}`,
              state,
              message: `engine detail for ${state}`,
            }),
          ),
        }),
      }),
    );
    expect(document.body.textContent ?? "").not.toMatch(/page\.peerState\./);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(states.length + 1);
    expect(
      within(rows[states.indexOf("pending") + 1] as HTMLElement).getByText("En attente"),
    ).toBeInTheDocument();
  });
});

describe("pending work and superseded publishes", () => {
  it("explains a peer left for the next run without showing the engine's English message", async () => {
    await renderPage(
      syncController({
        status: status({
          peers: [
            peer({
              state: "pending",
              message: "Not merged yet: the time budget ran out; the next sync continues",
            }),
          ],
        }),
      }),
    );
    expect(screen.getByText("En attente")).toBeInTheDocument();
    expect(
      screen.getByText(/le temps imparti à cette synchronisation est écoulé/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/time budget/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the run-wide safety-backup reason, with a link to Settings, for a halted first merge", async () => {
    const target = peer({
      state: "error",
      message:
        "A backup of this laptop is required before merging (first_merge) and could not be made",
    });
    await renderPage(
      syncController({
        status: status({
          peers: [target],
          lastPull: pullReport({
            complete: false,
            safetyBackup: { reasons: ["first_merge"], status: "failed" },
            peers: [
              {
                peerId: target.peerId,
                peerName: target.peerName,
                transport: "folder:gtd",
                status: "ok",
                domains: [{ domain: "gtd", outcome: "halted" }],
              },
            ],
          }),
        }),
      }),
    );
    expect(screen.getByText(/Première fusion arrêtée/)).toBeInTheDocument();
    expect(screen.queryByText(/A backup of this laptop is required/)).toBeNull();
    const row = screen.getByText(/Première fusion arrêtée/).closest("tr") as HTMLElement;
    expect(within(row).getByRole("link", { name: "Ouvrir les Paramètres" })).toHaveAttribute(
      "href",
      "/parametres",
    );
  });

  it("keeps the engine's message for an error that is not a halted merge", async () => {
    await renderPage(
      syncController({
        status: status({ peers: [peer({ state: "error", message: "rejected bundle" })] }),
      }),
    );
    expect(screen.getByText("rejected bundle")).toBeInTheDocument();
    expect(screen.queryByText(/Première fusion arrêtée/)).toBeNull();
  });

  it("names which folder is not connected when changes stay pending, as information", async () => {
    const run = {
      finishedAtMs: Date.now(),
      error: null,
      report: {
        pull: pullReport(),
        publish: publishReport({
          domains: [
            { domain: "gtd", outcome: "clean", transport: "folder:gtd" },
            { domain: "personal", outcome: "no_transport" },
            { domain: "finance", outcome: "no_transport" },
          ],
          issues: [
            issue({
              severity: "info",
              code: "pending_unpublished_domain",
              detail: "personal,finance",
              transport: undefined,
              message: "Changes stay pending because nothing carries the personal, finance data",
            }),
          ],
        }),
      },
    };
    await renderPage(syncController({ status: status(), run }));
    expect(
      screen.getByText(
        /Dossier non connecté : dossier personnel\. Tes changements restent en attente/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Info")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a publish replaced by a newer one as information, not an alarm", async () => {
    const run = {
      finishedAtMs: Date.now(),
      error: null,
      report: {
        pull: pullReport(),
        publish: publishReport({
          issues: [
            issue({
              severity: "info",
              code: "publish_skipped",
              detail: "stale_publish",
              domain: "gtd",
              transport: "folder:gtd",
              message: "The gtd publish was superseded by a newer one",
            }),
          ],
        }),
      },
    };
    await renderPage(syncController({ status: status(), run }));
    expect(
      screen.getByText(
        /La publication des données GTD a été remplacée par une plus récente : rien n'est perdu\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Erreur")).toBeNull();
  });
});
