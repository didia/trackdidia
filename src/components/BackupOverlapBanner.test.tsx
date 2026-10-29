import { screen } from "@testing-library/react";
import { defaultAppSettings } from "../domain/settings";
import { renderWithApp } from "../test/test-utils";
import { BackupOverlapBanner } from "./BackupOverlapBanner";

const banner = (backupDestinationDir: string, syncGtdFolderDir: string) =>
  renderWithApp(
    <BackupOverlapBanner
      settings={{ ...defaultAppSettings(), backupDestinationDir, syncGtdFolderDir }}
    />,
  );

describe("BackupOverlapBanner", () => {
  it.each([
    ["the same folder", "/Drive/GTD", "/Drive/GTD"],
    ["inside", "/Drive/GTD/backups", "/Drive/GTD"],
    ["around", "/Drive", "/Drive/GTD"],
  ])(
    "warns when the backup destination is %s the shared GTD folder",
    async (_label, backup, gtd) => {
      await banner(backup, gtd);
      expect(screen.getByRole("alert")).toHaveTextContent("Les backups sont arrêtés");
      expect(screen.getByRole("link", { name: "Ouvrir les paramètres" })).toHaveAttribute(
        "href",
        "/parametres",
      );
    },
  );

  it("is absent for users without sync or with apart folders", async () => {
    const none = await banner("/Drive/Perso", "");
    expect(screen.queryByRole("alert")).toBeNull();
    none.unmount();
    await banner("/Drive/Perso", "/Drive/GTD");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
