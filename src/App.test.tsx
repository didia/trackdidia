import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { FinanceRoutes } from "./App";
import { defaultAppSettings } from "./domain/daily-entry";
import { renderWithApp } from "./test/test-utils";

describe("FinanceRoutes gating", () => {
  it("redirects /finances to / when financeEnabled is false", async () => {
    await renderWithApp(
      <Routes>
        <Route index element={<p>today</p>} />
        <Route path="finances/*" element={<FinanceRoutes />} />
      </Routes>,
      {
        route: "/finances",
        contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: false } },
      },
    );

    expect(screen.getByText("today")).toBeInTheDocument();
  });

  it("renders the finance overview route when financeEnabled is true", async () => {
    await renderWithApp(
      <Routes>
        <Route index element={<p>today</p>} />
        <Route path="finances/*" element={<FinanceRoutes />} />
      </Routes>,
      {
        route: "/finances",
        contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
      },
    );

    expect(screen.queryByText("today")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Aperçu" })).toBeInTheDocument();
  });
});
