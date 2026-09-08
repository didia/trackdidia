import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { SectionCard } from "../components/SectionCard";
import {
  buildJournalFeed,
  resolveJournalDateRange,
  type JournalFeedItem,
  type JournalKind,
  type JournalKindFilter,
  type JournalPeriodPreset,
  type JournalSortOrder,
} from "../domain/journal-feed";
import type { MonthlyReviewSectionKey, WeeklyRitualSectionKey } from "../domain/types";
import { formatDateLong } from "../lib/date";

const formatMonthYear = (date: string): string =>
  new Intl.DateTimeFormat("fr-CA", {
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));

export const JournalPage = () => {
  const { t } = useTranslation("journal");
  const { t: tHistory } = useTranslation("history");
  const { t: tReviews } = useTranslation("reviews");
  const { repository, calendarDay } = useAppContext();
  const [period, setPeriod] = useState<JournalPeriodPreset>("thisWeek");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [kind, setKind] = useState<JournalKindFilter>("all");
  const [sort, setSort] = useState<JournalSortOrder>("newerFirst");
  const [items, setItems] = useState<JournalFeedItem[]>([]);
  const [loading, setLoading] = useState(true);

  const range = useMemo(
    () =>
      resolveJournalDateRange(period, calendarDay, {
        startDate: customStartDate,
        endDate: customEndDate,
      }),
    [calendarDay, customEndDate, customStartDate, period],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      const includeDaily = kind === "all" || kind === "daily";
      const includeWeekly = kind === "all" || kind === "weekly";
      const includeMonthly = kind === "all" || kind === "monthly";
      const [dailyEntries, weeklyReviews, monthlyReviews] = await Promise.all([
        includeDaily
          ? repository.listDailyEntriesInRange(range.startDate, range.endDate)
          : Promise.resolve([]),
        includeWeekly
          ? repository.listWeeklyReviewsOverlapping(range.startDate, range.endDate)
          : Promise.resolve([]),
        includeMonthly
          ? repository.listMonthlyReviewsOverlapping(range.startDate, range.endDate)
          : Promise.resolve([]),
      ]);

      if (cancelled) {
        return;
      }

      setItems(
        buildJournalFeed({
          dailyEntries,
          weeklyReviews,
          monthlyReviews,
          range,
          kind,
          sort,
        }),
      );
      setLoading(false);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [kind, range, repository, sort]);

  const handlePeriodChange = (nextPeriod: JournalPeriodPreset) => {
    if (nextPeriod === "custom") {
      const currentRange = resolveJournalDateRange(period, calendarDay, {
        startDate: customStartDate,
        endDate: customEndDate,
      });
      setCustomStartDate(currentRange.startDate);
      setCustomEndDate(currentRange.endDate);
    }
    setPeriod(nextPeriod);
  };

  const fieldLabel = (itemKind: JournalKind, key: string): string => {
    if (itemKind === "daily") {
      return tHistory(`editor.${key as "morningIntention" | "nightReflection" | "tomorrowFocus"}`);
    }
    if (itemKind === "weekly") {
      return tReviews(`weekly.ritual.${key as WeeklyRitualSectionKey}.title`);
    }
    return tReviews(`monthly.ritual.${key as MonthlyReviewSectionKey}.title`);
  };

  const periodLabel = (item: JournalFeedItem): string => {
    if (item.kind === "daily") {
      return formatDateLong(item.periodStartDate);
    }
    if (item.kind === "weekly") {
      return t("card.weekPeriod", {
        start: formatDateLong(item.periodStartDate),
        end: formatDateLong(item.periodEndDate),
      });
    }
    return formatMonthYear(item.periodStartDate);
  };

  if (loading && items.length === 0) {
    return (
      <div className="page">
        <p>{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("hero.eyebrow")}</p>
          <h2>{t("hero.title")}</h2>
          <p className="hero__copy">{t("hero.copy")}</p>
        </div>
      </header>

      <SectionCard title={t("filters.title")} subtitle={t("filters.subtitle")}>
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>{t("filters.period")}</span>
            <select
              aria-label={t("filters.period")}
              value={period}
              onChange={(event) => handlePeriodChange(event.target.value as JournalPeriodPreset)}
            >
              <option value="thisWeek">{t("filters.thisWeek")}</option>
              <option value="lastWeek">{t("filters.lastWeek")}</option>
              <option value="thisMonth">{t("filters.thisMonth")}</option>
              <option value="lastMonth">{t("filters.lastMonth")}</option>
              <option value="custom">{t("filters.custom")}</option>
            </select>
          </label>
          {period === "custom" ? (
            <>
              <label className="stacked-field">
                <span>{t("filters.startDate")}</span>
                <input
                  aria-label={t("filters.startDate")}
                  type="date"
                  value={customStartDate}
                  onChange={(event) => setCustomStartDate(event.target.value)}
                />
              </label>
              <label className="stacked-field">
                <span>{t("filters.endDate")}</span>
                <input
                  aria-label={t("filters.endDate")}
                  type="date"
                  value={customEndDate}
                  onChange={(event) => setCustomEndDate(event.target.value)}
                />
              </label>
            </>
          ) : null}
          <label className="stacked-field">
            <span>{t("filters.kind")}</span>
            <select
              aria-label={t("filters.kind")}
              value={kind}
              onChange={(event) => setKind(event.target.value as JournalKindFilter)}
            >
              <option value="all">{t("filters.all")}</option>
              <option value="daily">{t("filters.daily")}</option>
              <option value="weekly">{t("filters.weekly")}</option>
              <option value="monthly">{t("filters.monthly")}</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("filters.sort")}</span>
            <select
              aria-label={t("filters.sort")}
              value={sort}
              onChange={(event) => setSort(event.target.value as JournalSortOrder)}
            >
              <option value="newerFirst">{t("filters.newerFirst")}</option>
              <option value="olderFirst">{t("filters.olderFirst")}</option>
            </select>
          </label>
        </div>
      </SectionCard>

      <SectionCard title={t("list.title")} subtitle={t("list.subtitle", { count: items.length })}>
        {items.length === 0 ? (
          <p className="empty-copy">{t("list.empty")}</p>
        ) : (
          <div className="journal-feed">
            {items.map((item) => (
              <article key={`${item.kind}-${item.id}`} className="journal-feed-card">
                <header className="journal-feed-card__header">
                  <div className="journal-feed-card__meta">
                    <span className="tag-chip tag-chip--active">{t(`card.${item.kind}`)}</span>
                    <strong>{periodLabel(item)}</strong>
                  </div>
                  <Link className="button" to={item.href}>
                    {t("card.open")}
                  </Link>
                </header>
                {item.fields.map((field) => (
                  <div key={field.key} className="stacked-field">
                    <span>{fieldLabel(item.kind, field.key)}</span>
                    <p className="journal-feed-card__text">{field.text}</p>
                  </div>
                ))}
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
};
