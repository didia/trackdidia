import { NavLink, Outlet } from "react-router-dom";

const navigation = [
  { to: "/", label: "Aujourd'hui", end: true },
  { to: "/routine-matin", label: "Routine du matin" },
  { to: "/fermeture-soir", label: "Fermeture du soir" },
  { to: "/historique", label: "Historique quotidien" },
  { to: "/inbox", label: "Inbox GTD" },
  { to: "/next-actions", label: "Next Actions" },
  { to: "/projects", label: "Projects" },
  { to: "/references", label: "References" },
  { to: "/scheduled", label: "Scheduled" },
  { to: "/waiting-for", label: "Waiting For" },
  { to: "/someday-maybe", label: "Someday / Maybe" },
  { to: "/parametres", label: "Parametres" }
];

export const AppShell = () => (
  <div className="layout">
    <aside className="sidebar">
      <div className="brand-block">
        <p className="eyebrow">Trackdidia</p>
        <h1>Une journee bien tenue a la fois.</h1>
        <p className="sidebar__copy">
          Suivi quotidien, rituels du matin et du soir, discipline visible, et moteur GTD local-first sans
          bruit inutile.
        </p>
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

    <main className="content">
      <Outlet />
    </main>
  </div>
);
