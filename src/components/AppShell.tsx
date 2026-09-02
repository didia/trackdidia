import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FloatingPomodoroTimer } from "./FloatingPomodoroTimer";
import { NavLink, Outlet } from "react-router-dom";
import { getQuoteOfTheDay } from "../lib/quote-of-the-day";

const navigation = [
  { to: "/", labelKey: "today", end: true },
  { to: "/routine-matin", labelKey: "morningRoutine" },
  { to: "/fermeture-soir", labelKey: "eveningClose" },
  { to: "/semaine", labelKey: "week" },
  { to: "/mois", labelKey: "month" },
  { to: "/objectifs-annuels", labelKey: "annualGoals" },
  { to: "/historique", labelKey: "dailyHistory" },
  { to: "/inbox", labelKey: "gtdInbox" },
  { to: "/next-actions", labelKey: "nextActions" },
  { to: "/projects", labelKey: "projects" },
  { to: "/pomodoro", labelKey: "pomodoro" },
  { to: "/recurrences", labelKey: "recurrences" },
  { to: "/references", labelKey: "references" },
  { to: "/scheduled", labelKey: "scheduled" },
  { to: "/waiting-for", labelKey: "waitingFor" },
  { to: "/someday-maybe", labelKey: "somedayMaybe" },
  { to: "/parametres", labelKey: "settings" }
] as const;

export const AppShell = () => {
  const { t } = useTranslation("nav");
  const { t: tCommon } = useTranslation("common");
  const { pomodoro } = useAppContext();
  const hasFloatingPomodoro = Boolean(pomodoro.state.activeSession);
  const quoteOfTheDay = getQuoteOfTheDay();

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand-block">
          <p className="eyebrow">{tCommon("brand")}</p>
          <h1>{quoteOfTheDay.quote}</h1>
          <p className="sidebar__copy">{t("authorPrefix", { author: quoteOfTheDay.author })}</p>
        </div>

        <nav className="nav">
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              end={"end" in item ? item.end : undefined}
              to={item.to}
              className={({ isActive }) => `nav__link${isActive ? " nav__link--active" : ""}`}
            >
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className={`content${hasFloatingPomodoro ? " content--with-floating-pomodoro" : ""}`}>
        <Outlet />
      </main>

      <FloatingPomodoroTimer />
    </div>
  );
};
