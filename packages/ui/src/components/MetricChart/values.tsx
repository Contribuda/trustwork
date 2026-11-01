import { formatNumber, intlTag, t } from "../../i18n";
/** Suppressed values arrive without the hidden number; suppression is decided upstream. */
export type DisplayCount =
  { kind: "value"; value: number } | { kind: "suppressed"; below: number };
export function countText(value: DisplayCount): string {
  return value.kind === "suppressed"
    ? t("consoleKit.suppressed", { count: formatNumber(value.below) })
    : formatNumber(value.value);
}
export function CohortCount({ value }: { value: DisplayCount }) {
  return <span>{countText(value)}</span>;
}
/** Decimal currency amounts are supplied by the domain; no floating-point accounting occurs here. */
export function CostCell({
  amount,
  currency,
}: {
  amount: string;
  currency: string;
}) {
  return (
    <span>
      {new Intl.NumberFormat(intlTag(), { style: "currency", currency }).format(
        amount as `${number}`,
      )}
    </span>
  );
}
export function MarginCell({
  amount,
  currency,
  negative,
}: {
  amount: string;
  currency: string;
  negative: boolean;
}) {
  return (
    <span>
      <CostCell amount={amount} currency={currency} />
      {negative && <> · {t("consoleKit.negativeMargin")}</>}
    </span>
  );
}
export function BudgetMeter({
  label,
  used,
  limit,
  currency,
  fraction,
}: {
  label: string;
  used: string;
  limit: string;
  currency: string;
  fraction: number;
}) {
  return (
    <div>
      <p>
        {label}: <CostCell amount={used} currency={currency} /> /{" "}
        <CostCell amount={limit} currency={currency} />
      </p>
      <meter
        aria-label={label}
        min={0}
        max={1}
        value={Math.max(0, Math.min(1, fraction))}
      />
    </div>
  );
}
