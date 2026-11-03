import { fireEvent, render, screen } from "@testing-library/react";
import { FirstRunProfileChoice } from "./FirstRunProfileChoice";

describe("FirstRunProfileChoice", () => {
  it("offers personal use and Settings while work is disabled", () => {
    const choose = vi.fn().mockResolvedValue(true);
    const onJoin = vi.fn();
    render(
      <FirstRunProfileChoice
        choose={choose}
        onJoin={onJoin}
        error={null}
        busy={false}
        workSelectable={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Ordinateur professionnel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ordinateur personnel" }));
    expect(choose).toHaveBeenCalledWith("personal");
    fireEvent.click(screen.getByRole("button", { name: "Configurer la synchronisation" }));
    expect(onJoin).toHaveBeenCalledOnce();
  });

  it("shows an error and allows a retry", () => {
    const choose = vi.fn().mockResolvedValue(true);
    render(
      <FirstRunProfileChoice
        choose={choose}
        onJoin={() => undefined}
        error="disque inaccessible"
        busy={false}
        workSelectable
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("disque inaccessible");
    fireEvent.click(screen.getByRole("button", { name: "Ordinateur professionnel" }));
    expect(choose).toHaveBeenCalledWith("work");
  });
});
