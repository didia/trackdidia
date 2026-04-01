import type { PropsWithChildren } from "react";

interface SectionCardProps extends PropsWithChildren {
  title: string;
  subtitle?: string;
  aside?: React.ReactNode;
}

export const SectionCard = ({ title, subtitle, aside, children }: SectionCardProps) => (
  <section className="panel">
    <header className="panel__header">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {aside ? <div>{aside}</div> : null}
    </header>
    {children}
  </section>
);

