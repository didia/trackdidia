import type { TFunction } from "i18next";
import type { SyncIssue } from "../../lib/sync/engine-types";

/** Folder ids the folder transport reports, in the words the page uses. */
export const folderLabel = (t: TFunction<"sync">, transport: string | undefined): string => {
  switch (transport) {
    case "folder:gtd":
      return t("page.issues.folder.gtd");
    case "folder:personal":
      return t("page.issues.folder.personal");
    default:
      return transport ?? "";
  }
};

const domainLabel = (t: TFunction<"sync">, domain: string | undefined): string => {
  switch (domain) {
    case "gtd":
      return t("page.domain.gtd");
    case "personal":
      return t("page.domain.personal");
    case "finance":
      return t("page.domain.finance");
    default:
      return domain ?? "";
  }
};

/** Pairs each issue with a React key that stays unique when the same issue is reported twice. */
export const keyedIssues = (issues: readonly SyncIssue[]): { key: string; issue: SyncIssue }[] => {
  const seen = new Map<string, number>();
  return issues.map((issue) => {
    const base = [
      issue.severity,
      issue.code,
      issue.transport ?? "",
      issue.peerId ?? "",
      issue.domain ?? "",
      issue.message,
    ].join("|");
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: `${base}#${count}`, issue };
  });
};

/** Failures retrying cannot fix: the page shows them first and prominently. */
export type PersistentKind = "configuration" | "too_large" | "unsupported" | "internal";

const PERSISTENT_KINDS: readonly string[] = [
  "configuration",
  "too_large",
  "unsupported",
  "internal",
];

export const persistentKindOf = (issue: SyncIssue): PersistentKind | null =>
  (issue.code === "transport_failed" || issue.code === "publish_failed") &&
  issue.detail !== undefined &&
  PERSISTENT_KINDS.includes(issue.detail)
    ? (issue.detail as PersistentKind)
    : null;

export interface DescribedIssue {
  /** Headline for a persistent failure; absent for an ordinary issue. */
  title?: string;
  body: string;
  persistent: PersistentKind | null;
}

/**
 * The French text of an engine issue. Matching is on `code` and `detail`, never on the engine's
 * English `message`, which is kept only as the technical detail underneath.
 */
export const describeIssue = (t: TFunction<"sync">, issue: SyncIssue): DescribedIssue => {
  const persistent = persistentKindOf(issue);
  const folder = folderLabel(t, issue.transport);
  if (persistent !== null) {
    const key = {
      configuration: "configuration",
      too_large: "tooLarge",
      unsupported: "unsupported",
      internal: "internal",
    }[persistent] as "configuration" | "tooLarge" | "unsupported" | "internal";
    return {
      title: t(`page.issues.${key}.title`),
      body: t(`page.issues.${key}.body`, { folder }),
      persistent,
    };
  }
  if (issue.code === "publish_skipped" && issue.detail === "stale_publish") {
    // A newer publish of the same domain overtook this one: information, not a problem.
    return {
      body: t("page.issues.supersededPublish", { domain: domainLabel(t, issue.domain) }),
      persistent: null,
    };
  }
  if (issue.code === "pending_unpublished_domain") {
    const folders = [
      ...new Set(
        (issue.detail ?? "")
          .split(",")
          .filter((domain) => domain !== "")
          .map((domain) => folderLabel(t, domain === "gtd" ? "folder:gtd" : "folder:personal")),
      ),
    ].join(" ; ");
    return {
      body: t("page.issues.code.pending_unpublished_domain", { folders }),
      persistent: null,
    };
  }
  if (issue.code === "transport_unreachable" && issue.detail === "folder_not_prepared") {
    return { body: t("page.issues.code.folder_not_prepared", { folder }), persistent: null };
  }
  return {
    body: t(`page.issues.code.${issue.code}`, {
      folder,
      name: issue.peerName ?? issue.peerId ?? "",
      domain: issue.domain ?? "",
      kept: issue.progress?.kept ?? 0,
      total: issue.progress?.total ?? 0,
    }),
    persistent: null,
  };
};
