import type { TaskContext } from "../domain/types";
import { SegmentedToggle } from "./SegmentedToggle";

interface ContextFilterChipsProps {
  contexts: readonly Pick<TaskContext, "id" | "name">[];
  /** Selected context id, or "all". */
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
}

export const ContextFilterChips = ({
  contexts,
  value,
  onChange,
  allLabel,
}: ContextFilterChipsProps) => (
  <SegmentedToggle
    options={[
      { value: "all", label: allLabel },
      ...contexts.map((context) => ({ value: context.id, label: context.name })),
    ]}
    value={value}
    onChange={onChange}
  />
);
