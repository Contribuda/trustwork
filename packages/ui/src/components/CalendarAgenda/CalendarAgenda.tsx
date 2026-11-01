import { formatDate, formatNumber, intlTag } from "../../i18n";
import { Button } from "../Button/Button";
import { ConsoleTime } from "../AuditTrail/AuditTrail";
import s from "../DataTable/console.module.css";
export type AgendaEvent = {
  id: string;
  title: string;
  startsAt: string;
  stateLabel: string;
  onOpen: () => void;
};
export function eventDay(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (key: string) => parts.find((p) => p.type === key)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function CalendarAgenda({
  label,
  month,
  events,
  timeZone,
}: {
  label: string;
  month: string;
  events: readonly AgendaEvent[];
  timeZone: string;
}) {
  const [year, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year!, m!, 0)).getUTCDate();
  const days = Array.from(
    { length: count },
    (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
  );
  const listed = [...events].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  return (
    <section className={s.stack} aria-label={label}>
      <h2>{label}</h2>
      <p>
        {new Intl.DateTimeFormat(intlTag(), {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${month}-01T00:00:00Z`))}{" "}
        · {timeZone}
      </p>
      <div className={s.calendar} aria-hidden="true">
        {days.map((day, i) => (
          <div
            className={s.day}
            key={day}
            style={
              i === 0
                ? {
                    gridColumnStart:
                      ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1,
                  }
                : undefined
            }
          >
            <strong>{formatNumber(i + 1)}</strong>
            {listed
              .filter((e) => eventDay(e.startsAt, timeZone) === day)
              .map((e) => (
                <p key={e.id}>{e.title}</p>
              ))}
          </div>
        ))}
      </div>
      <ol className={s.list}>
        {listed.map((e) => (
          <li key={e.id} className={s.panel}>
            <p>{formatDate(eventDay(e.startsAt, timeZone))}</p>
            <ConsoleTime value={e.startsAt} timeZone={timeZone} />
            <p>{e.stateLabel}</p>
            <Button variant="secondary" onPress={e.onOpen}>
              {e.title}
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
