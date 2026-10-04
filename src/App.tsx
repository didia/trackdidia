import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppProvider, useAppContext } from "./app/app-context";
import { AppShell } from "./components/AppShell";
import { AnnualGoalsPage } from "./pages/AnnualGoalsPage";
import { EmailTriagePage } from "./pages/EmailTriagePage";
import { EveningClosurePage } from "./pages/EveningClosurePage";
import { FinanceAccountsPage } from "./pages/FinanceAccountsPage";
import { FinanceBudgetPage } from "./pages/FinanceBudgetPage";
import { FinanceImportPage } from "./pages/FinanceImportPage";
import { FinanceOverviewPage } from "./pages/FinanceOverviewPage";
import { FinanceReportsPage } from "./pages/FinanceReportsPage";
import { FinanceReviewPage } from "./pages/FinanceReviewPage";
import { FinanceRulesPage } from "./pages/FinanceRulesPage";
import { FinanceTransactionsPage } from "./pages/FinanceTransactionsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { InboxPage } from "./pages/InboxPage";
import { JournalPage } from "./pages/JournalPage";
import { MonthlyReviewPage } from "./pages/MonthlyReviewPage";
import { MorningRoutinePage } from "./pages/MorningRoutinePage";
import { NextActionsPage } from "./pages/NextActionsPage";
import { PomodoroPage } from "./pages/PomodoroPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RecurrencesPage } from "./pages/RecurrencesPage";
import { ReferencesPage } from "./pages/ReferencesPage";
import { ScheduledPage } from "./pages/ScheduledPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SomedayMaybePage } from "./pages/SomedayMaybePage";
import { MidWeekReviewPage } from "./pages/MidWeekReviewPage";
import { TodayPage } from "./pages/TodayPage";
import { WaitingForPage } from "./pages/WaitingForPage";
import { WeeklyReviewPage } from "./pages/WeeklyReviewPage";

/** `/finances*` stays registered but redirects to `/` while the feature flag is off. */
export const FinanceRoutes = () => {
  const { settings } = useAppContext();

  if (!settings.financeEnabled) {
    return <Navigate to="/" replace />;
  }

  return (
    <Routes>
      <Route index element={<FinanceOverviewPage />} />
      <Route path="transactions" element={<FinanceTransactionsPage />} />
      <Route path="budget" element={<FinanceBudgetPage />} />
      <Route path="reports" element={<FinanceReportsPage />} />
      <Route path="import" element={<FinanceImportPage />} />
      <Route path="accounts" element={<FinanceAccountsPage />} />
      <Route path="review" element={<FinanceReviewPage />} />
      <Route path="rules" element={<FinanceRulesPage />} />
    </Routes>
  );
};

export const App = () => (
  <BrowserRouter>
    <AppProvider>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<TodayPage />} />
          <Route path="routine-matin" element={<MorningRoutinePage />} />
          <Route path="fermeture-soir" element={<EveningClosurePage />} />
          <Route path="semaine" element={<WeeklyReviewPage />} />
          <Route path="mi-semaine" element={<MidWeekReviewPage />} />
          <Route path="mois" element={<MonthlyReviewPage />} />
          <Route path="objectifs-annuels" element={<AnnualGoalsPage />} />
          <Route path="historique" element={<HistoryPage />} />
          <Route path="journal" element={<JournalPage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="next-actions" element={<NextActionsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="pomodoro" element={<PomodoroPage />} />
          <Route path="recurrences" element={<RecurrencesPage />} />
          <Route path="email-triage" element={<EmailTriagePage />} />
          <Route path="references" element={<ReferencesPage />} />
          <Route path="scheduled" element={<ScheduledPage />} />
          <Route path="waiting-for" element={<WaitingForPage />} />
          <Route path="someday-maybe" element={<SomedayMaybePage />} />
          <Route path="waiting-someday" element={<Navigate to="/waiting-for" replace />} />
          <Route path="finances/*" element={<FinanceRoutes />} />
          <Route path="parametres" element={<SettingsPage />} />
        </Route>
      </Routes>
    </AppProvider>
  </BrowserRouter>
);
