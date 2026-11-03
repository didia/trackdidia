import { screen } from "@testing-library/react";
import { AppRoutes } from "./App";
import { renderWithApp } from "./test/test-utils";

describe("work routes", () => {
  it.each(["/", "/journal", "/finances", "/routine-matin"])(
    "opens Next Actions for %s without personal navigation",
    async (route) => {
      await renderWithApp(<AppRoutes />, { route, contextOverrides: { deviceProfile: "work" } });
      expect(await screen.findByRole("link", { name: /Next Actions/i })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Journal/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Finances/i })).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Le terrain exécutable du moment." }),
      ).toBeInTheDocument();
    },
  );
});
