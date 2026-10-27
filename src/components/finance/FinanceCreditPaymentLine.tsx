import { useTranslation } from "react-i18next";
import {
  FINANCE_PAYMENT_SOON_DAYS,
  type FinanceCreditPaymentDue,
} from "../../domain/finance/credit-payment";
import { formatDateMedium } from "../../lib/date";
import { formatMoney } from "../../lib/finance/money";

interface FinanceCreditPaymentLineProps {
  due: FinanceCreditPaymentDue;
  currency: string;
  testId?: string;
}

/** "Échéance le 15 nov. 2026 (dans 3 jours) · Minimum estimé : 45,00 $" for a credit account. */
export const FinanceCreditPaymentLine = ({
  due,
  currency,
  testId,
}: FinanceCreditPaymentLineProps) => {
  const { t } = useTranslation("finance");
  const parts: string[] = [];

  if (due.dueDate !== null && due.daysUntil !== null) {
    const when =
      due.daysUntil === 0
        ? t("creditPayment.today")
        : t("creditPayment.inDays", { count: due.daysUntil });
    parts.push(`${t("creditPayment.dueOn", { date: formatDateMedium(due.dueDate) })} (${when})`);
  }

  parts.push(
    due.owedMinor === 0
      ? t("creditPayment.nothingOwed")
      : t(due.minimumIsEstimate ? "creditPayment.minimumEstimated" : "creditPayment.minimum", {
          amount: formatMoney({ amountMinor: due.minimumMinor, currency }),
        }),
  );

  const soon =
    due.owedMinor > 0 && due.daysUntil !== null && due.daysUntil <= FINANCE_PAYMENT_SOON_DAYS;

  return (
    <span
      className={`finance-row__meta finance-payment${soon ? " finance-payment--soon" : ""}`}
      data-testid={testId}
    >
      {parts.join(" · ")}
    </span>
  );
};
