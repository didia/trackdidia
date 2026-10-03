import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";

// Only tabs for screens that exist ship here. Budget/reports land in later
// finance phases — see docs/finance.md "Screens".
const financeTabs = [
  { to: "/finances", labelKey: "tabs.overview", end: true },
  { to: "/finances/transactions", labelKey: "tabs.transactions", end: false },
  { to: "/finances/import", labelKey: "tabs.import", end: false },
  { to: "/finances/accounts", labelKey: "tabs.accounts", end: false },
  { to: "/finances/review", labelKey: "tabs.review", end: false },
  { to: "/finances/rules", labelKey: "tabs.rules", end: false },
] as const;

export const FinanceTabs = () => {
  const { t } = useTranslation("finance");

  return (
    <nav className="tabs" aria-label={t("tabs.label")}>
      {financeTabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => `tabs__link${isActive ? " tabs__link--active" : ""}`}
        >
          {t(tab.labelKey)}
        </NavLink>
      ))}
    </nav>
  );
};
