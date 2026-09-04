import type { TOptions } from "i18next";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import coach from "../locales/fr/coach.json";
import common from "../locales/fr/common.json";
import evening from "../locales/fr/evening.json";
import goals from "../locales/fr/goals.json";
import gtd from "../locales/fr/gtd.json";
import history from "../locales/fr/history.json";
import insights from "../locales/fr/insights.json";
import metrics from "../locales/fr/metrics.json";
import morning from "../locales/fr/morning.json";
import nav from "../locales/fr/nav.json";
import notifications from "../locales/fr/notifications.json";
import pomodoro from "../locales/fr/pomodoro.json";
import principles from "../locales/fr/principles.json";
import recurrences from "../locales/fr/recurrences.json";
import relationship from "../locales/fr/relationship.json";
import relativeTime from "../locales/fr/relativeTime.json";
import reviews from "../locales/fr/reviews.json";
import settings from "../locales/fr/settings.json";
import today from "../locales/fr/today.json";

export const defaultNS = "common";

export const resources = {
  fr: {
    common,
    nav,
    today,
    morning,
    evening,
    history,
    gtd,
    pomodoro,
    recurrences,
    reviews,
    goals,
    settings,
    coach,
    metrics,
    principles,
    notifications,
    relativeTime,
    insights,
    relationship,
  },
} as const;

void i18n.use(initReactI18next).init({
  lng: "fr",
  fallbackLng: "fr",
  defaultNS,
  ns: Object.keys(resources.fr),
  resources,
  interpolation: { escapeValue: false },
  returnNull: false,
});

if (typeof document !== "undefined") {
  document.documentElement.lang = "fr";
}

const translate = i18n.t as unknown as (key: string, options?: Record<string, unknown>) => unknown;

export const t = (key: string, options?: TOptions): string =>
  String(translate(key, options as Record<string, unknown> | undefined));

export const tList = (key: string, ns: string): string[] => {
  const value = translate(key, { ns, returnObjects: true });
  return Array.isArray(value) ? value.map(String) : [];
};

export default i18n;
