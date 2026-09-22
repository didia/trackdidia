import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SectionCard } from "../SectionCard";
import type { AppRepository } from "../../lib/storage/repository";

interface StorageOverviewSectionProps {
  repository: AppRepository;
  gtdImportDoneAt: string;
}

interface GtdOverview {
  taskCount: number;
  projectCount: number;
  contextCount: number;
}

export const StorageOverviewSection = ({
  repository,
  gtdImportDoneAt,
}: StorageOverviewSectionProps) => {
  const { t } = useTranslation("settings");
  const [gtdOverview, setGtdOverview] = useState<GtdOverview | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadGtdOverview = async () => {
      const overview = await repository.getGtdOverview();
      if (!cancelled) {
        setGtdOverview(overview);
      }
    };

    void loadGtdOverview();

    return () => {
      cancelled = true;
    };
  }, [repository]);

  return (
    <SectionCard title={t("gtdImport.title")} subtitle={t("gtdImport.subtitle")}>
      <div className="status-grid">
        <article className="status-card">
          <span>{t("gtdImport.stats.tasks")}</span>
          <strong>{gtdOverview?.taskCount ?? t("loadingPlaceholder")}</strong>
        </article>
        <article className="status-card">
          <span>{t("gtdImport.stats.projects")}</span>
          <strong>{gtdOverview?.projectCount ?? t("loadingPlaceholder")}</strong>
        </article>
        <article className="status-card">
          <span>{t("gtdImport.stats.contexts")}</span>
          <strong>{gtdOverview?.contextCount ?? t("loadingPlaceholder")}</strong>
        </article>
        <article className="status-card">
          <span>{t("gtdImport.stats.lastImport")}</span>
          <strong>{gtdImportDoneAt || t("backup.never")}</strong>
        </article>
      </div>
    </SectionCard>
  );
};
