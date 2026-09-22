export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedToggleProps<T extends string> {
  options: readonly SegmentedToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export const SegmentedToggle = <T extends string>({
  options,
  value,
  onChange,
}: SegmentedToggleProps<T>) => (
  <div className="tag-row">
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        className={`tag-chip${value === option.value ? " tag-chip--active" : ""}`}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);
