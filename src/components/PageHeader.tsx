import type { ReactNode } from "react";

interface PageHeaderProps {
  eyebrow: string;
  title: ReactNode;
  copy?: string;
  actions?: ReactNode;
}

export const PageHeader = ({ eyebrow, title, copy, actions }: PageHeaderProps) => (
  <header className="hero">
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {copy ? <p className="hero__copy">{copy}</p> : null}
    </div>
    {actions ? <div className="hero__actions">{actions}</div> : null}
  </header>
);
