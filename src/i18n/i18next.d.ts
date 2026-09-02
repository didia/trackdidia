import "i18next";
import type common from "../locales/fr/common.json";
import type nav from "../locales/fr/nav.json";
import type today from "../locales/fr/today.json";
import type morning from "../locales/fr/morning.json";
import type evening from "../locales/fr/evening.json";
import type history from "../locales/fr/history.json";
import type gtd from "../locales/fr/gtd.json";
import type pomodoro from "../locales/fr/pomodoro.json";
import type recurrences from "../locales/fr/recurrences.json";
import type reviews from "../locales/fr/reviews.json";
import type goals from "../locales/fr/goals.json";
import type settings from "../locales/fr/settings.json";
import type coach from "../locales/fr/coach.json";
import type metrics from "../locales/fr/metrics.json";
import type principles from "../locales/fr/principles.json";
import type notifications from "../locales/fr/notifications.json";
import type relativeTime from "../locales/fr/relativeTime.json";
import type insights from "../locales/fr/insights.json";
import type relationship from "../locales/fr/relationship.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    returnNull: false;
    resources: {
      common: typeof common;
      nav: typeof nav;
      today: typeof today;
      morning: typeof morning;
      evening: typeof evening;
      history: typeof history;
      gtd: typeof gtd;
      pomodoro: typeof pomodoro;
      recurrences: typeof recurrences;
      reviews: typeof reviews;
      goals: typeof goals;
      settings: typeof settings;
      coach: typeof coach;
      metrics: typeof metrics;
      principles: typeof principles;
      notifications: typeof notifications;
      relativeTime: typeof relativeTime;
      insights: typeof insights;
      relationship: typeof relationship;
    };
  }
}
