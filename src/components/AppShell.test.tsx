import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { defaultAppSettings } from "../domain/daily-entry";
import { renderWithApp } from "../test/test-utils";
import { AppShell } from "./AppShell";

describe("AppShell finance nav gating", () => {
  it("hides the Finances nav link when financeEnabled is false", async () => {
    await renderWithApp(
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<p>today</p>} />
        </Route>
      </Routes>,
      { contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: false } } },
    );

    expect(screen.queryByRole("link", { name: "Finances" })).not.toBeInTheDocument();
  });

  it("shows the Finances nav link when financeEnabled is true", async () => {
    await renderWithApp(
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<p>today</p>} />
        </Route>
      </Routes>,
      { contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } } },
    );

    expect(screen.getByRole("link", { name: "Finances" })).toBeInTheDocument();
  });
});
