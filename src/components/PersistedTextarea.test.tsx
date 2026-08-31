import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersistedTextarea } from "./PersistedTextarea";

describe("PersistedTextarea", () => {
  it("flushes a pending debounced value on unmount", async () => {
    const onPersist = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <PersistedTextarea
        aria-label="Notes"
        savedValue=""
        debounceMs={450}
        onPersist={onPersist}
      />
    );

    await user.type(screen.getByLabelText("Notes"), "hello");
    expect(onPersist).not.toHaveBeenCalled();

    unmount();

    expect(onPersist).toHaveBeenCalledWith("hello");
  });
});
