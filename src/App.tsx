import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import { AppProvider } from "./app/app-context";
import { AppShell } from "./components/AppShell";
import { EveningClosurePage } from "./pages/EveningClosurePage";
import { HistoryPage } from "./pages/HistoryPage";
import { InboxPage } from "./pages/InboxPage";
import { MorningRoutinePage } from "./pages/MorningRoutinePage";
import { NextActionsPage } from "./pages/NextActionsPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { PomodoroPage } from "./pages/PomodoroPage";
import { RecurrencesPage } from "./pages/RecurrencesPage";
import { ReferencesPage } from "./pages/ReferencesPage";
import { ScheduledPage } from "./pages/ScheduledPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SomedayMaybePage } from "./pages/SomedayMaybePage";
import { TodayPage } from "./pages/TodayPage";
import { WaitingForPage } from "./pages/WaitingForPage";
import { WeeklyReviewPage } from "./pages/WeeklyReviewPage";
import { MonthlyReviewPage } from "./pages/MonthlyReviewPage";
import { AnnualGoalsPage } from "./pages/AnnualGoalsPage";

export const App = () => (
  <BrowserRouter>
    <AppProvider>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<TodayPage />} />
          <Route path="routine-matin" element={<MorningRoutinePage />} />
          <Route path="fermeture-soir" element={<EveningClosurePage />} />
          <Route path="semaine" element={<WeeklyReviewPage />} />
          <Route path="mois" element={<MonthlyReviewPage />} />
          <Route path="objectifs-annuels" element={<AnnualGoalsPage />} />
          <Route path="historique" element={<HistoryPage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="next-actions" element={<NextActionsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="pomodoro" element={<PomodoroPage />} />
          <Route path="recurrences" element={<RecurrencesPage />} />
          <Route path="references" element={<ReferencesPage />} />
          <Route path="scheduled" element={<ScheduledPage />} />
          <Route path="waiting-for" element={<WaitingForPage />} />
          <Route path="someday-maybe" element={<SomedayMaybePage />} />
          <Route path="waiting-someday" element={<Navigate to="/waiting-for" replace />} />
          <Route path="parametres" element={<SettingsPage />} />
        </Route>
      </Routes>
    </AppProvider>
  </BrowserRouter>
);
