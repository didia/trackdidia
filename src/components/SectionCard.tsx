import { type PropsWithChildren, useId } from "react";

interface SectionCardProps extends PropsWithChildren {
  title: string;
  subtitle?: string;
  aside?: React.ReactNode;
}

export const SectionCard = ({ title, subtitle, aside, children }: SectionCardProps) => {
  const headingId = useId();

  return (
    <section className="panel" aria-labelledby={headingId}>
      <header className="panel__header">
        <div>
          <h2 id={headingId}>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {aside ? <div>{aside}</div> : null}
      </header>
      {children}
    </section>
  );
};
