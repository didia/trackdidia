import { useAppContext } from "../app/app-context";
import { FloatingPomodoroTimer } from "./FloatingPomodoroTimer";
import { NavLink, Outlet } from "react-router-dom";
import { getQuoteOfTheDay } from "../lib/quote-of-the-day";

const navigation = [
  { to: "/", label: "Aujourd'hui", end: true },
  { to: "/routine-matin", label: "Routine du matin" },
  { to: "/fermeture-soir", label: "Fermeture du soir" },
  { to: "/semaine", label: "Semaine" },
  { to: "/mois", label: "Mois" },
  { to: "/objectifs-annuels", label: "Objectifs annuels" },
  { to: "/historique", label: "Historique quotidien" },
  { to: "/inbox", label: "Inbox GTD" },
  { to: "/next-actions", label: "Next Actions" },
  { to: "/projects", label: "Projects" },
  { to: "/pomodoro", label: "Pomodoro" },
  { to: "/recurrences", label: "Recurrences" },
  { to: "/references", label: "References" },
  { to: "/scheduled", label: "Scheduled" },
  { to: "/waiting-for", label: "Waiting For" },
  { to: "/someday-maybe", label: "Someday / Maybe" },
  { to: "/parametres", label: "Parametres" }
];

export const AppShell = () => {
  const { pomodoro } = useAppContext();
  const hasFloatingPomodoro = Boolean(pomodoro.state.activeSession && pomodoro.remainingMs > 0);
  const quoteOfTheDay = getQuoteOfTheDay();

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand-block">
          <p className="eyebrow">Trackdidia</p>
          <h1>{quoteOfTheDay.quote}</h1>
          <p className="sidebar__copy">Auteur: {quoteOfTheDay.author}</p>
        </div>

        <nav className="nav">
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              end={item.end}
              to={item.to}
              className={({ isActive }) => `nav__link${isActive ? " nav__link--active" : ""}`}
            >
              {item.label}
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
