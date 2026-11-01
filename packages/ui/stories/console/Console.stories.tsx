import { useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SortDescriptor } from "react-aria-components";
import { getLocaleStore, setLocaleStore } from "@trustwork/i18n-runtime";
import { uiLayers } from "../../src/i18n/dictionaries";
import {
  t,
  formatNumber,
  intlTag,
  uiLocales,
  localeTag,
  UiProvider,
  Button,
  Checkbox,
  DataTable,
  FacetPanel,
  SavedViews,
  BulkActionBar,
  DetailDrawer,
  AuditTrail,
  DiffViewer,
  ApprovalCard,
  PermissionMatrix,
  ScopePicker,
  EffectiveAccess,
  LockedRule,
  KillSwitchControl,
  StepUpPrompt,
  TypedConfirmation,
  CommandPalette,
  InboxList,
  InlineHelp,
  KeyboardShortcuts,
  RunHistory,
  StatusLabel,
  CalendarAgenda,
  MetricChart,
  NetworkMap,
  BudgetMeter,
  MarginCell,
  type TableSelection,
  type SavedView,
  type ViewConfiguration,
} from "../../src";
import s from "../../src/components/DataTable/console.module.css";

const meta = {
  title: "Console/Kit",
  // The registered Playwright suite runs and awaits axe; avoid a second concurrent addon run.
  parameters: { layout: "padded" },
  globals: { a11y: { manual: true } },
  decorators: [
    (Story) => (
      <Fixture>
        <Story />
      </Fixture>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const label = (count = 1) =>
  t("consoleKit.item", { count: formatNumber(count) });
const at = "2026-11-01T18:00:00Z";
const zone = "America/Los_Angeles";
function Fixture({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(localeTag());
  return (
    <UiProvider>
      <main className={s.stack}>
        <p role="note">{t("consoleKit.synthetic")}</p>
        <label>
          {t("consoleKit.language")}
          <select
            value={language}
            onChange={(event) => {
              const tag = event.target.value;
              setLocaleStore({
                ...getLocaleStore(),
                locale: tag,
                layers: uiLayers(tag),
              });
              document.documentElement.lang = tag;
              setLanguage(tag);
            }}
          >
            {["en", "es", "ru", "uz-Latn", "ka", "hy", "az-Latn"]
              .filter((tag) => uiLocales().includes(tag))
              .map((tag) => (
                <option key={tag} value={tag}>
                  {new Intl.DisplayNames([language], { type: "language" }).of(
                    tag,
                  )}
                </option>
              ))}
          </select>
        </label>
        <div key={language}>{children}</div>
      </main>
    </UiProvider>
  );
}
function RecordsExample() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<string[]>(["pending"]);
  const [sort, setSort] = useState<SortDescriptor>();
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<TableSelection>({
    kind: "keys",
    keys: new Set(),
  });
  const [visible, setVisible] = useState(["name", "status"]);
  const [order, setOrder] = useState(["name", "status"]);
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  const [opened, setOpened] = useState<number>();
  const [selectedView, setSelectedView] = useState<string | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const current: ViewConfiguration = {
    query,
    filters: { state: filters },
    columns: visible,
    sort,
  };
  // A fixed synthetic server page: query callbacks intentionally do not pretend to fetch or filter records.
  const rows = [1, 2, 3].map((id) => ({ id }));
  const total = 120;
  const snapshot = `${query}/${filters.join(",")}`;
  const count =
    selection.kind === "keys"
      ? selection.keys.size
      : selection.snapshot === snapshot
        ? total - selection.excluded.size
        : 0;
  return (
    <div className={s.stack}>
      <SavedViews
        views={views}
        selectedId={selectedView}
        current={current}
        allowShare
        onSelect={(id) => {
          const view = views.find((v) => v.id === id)!;
          setSelectedView(id);
          setQuery(view.configuration.query);
          setFilters([...(view.configuration.filters.state ?? [])]);
          setVisible([...view.configuration.columns]);
          setSort(view.configuration.sort);
        }}
        onSave={(view) => {
          const id = String(views.length);
          setViews([...views, { ...view, id }]);
          setSelectedView(id);
        }}
        onShare={(id, shared) =>
          setViews(views.map((v) => (v.id === id ? { ...v, shared } : v)))
        }
        onDefault={(id) =>
          setViews(views.map((v) => ({ ...v, isDefault: v.id === id })))
        }
      />
      <FacetPanel
        facets={[
          {
            id: "state",
            label: t("consoleKit.status"),
            options: [
              {
                id: "pending",
                label: t("consoleKit.pending"),
                count: { kind: "value", value: 120 },
              },
              {
                id: "other",
                label: t("consoleKit.unknown"),
                count: { kind: "suppressed", below: 10 },
              },
            ],
          },
        ]}
        selected={{ state: filters }}
        onChange={(_, values) => setFilters(values)}
      />
      <BulkActionBar
        count={count}
        total={total}
        onCancel={() => setSelection({ kind: "keys", keys: new Set() })}
      >
        <Button onPress={() => setOpened(1)}>{t("consoleKit.approve")}</Button>
      </BulkActionBar>
      <DataTable
        caption={t("consoleKit.synthetic")}
        rows={rows}
        rowKey={(r) => r.id}
        server
        sort={sort}
        onSortChange={setSort}
        columns={[
          {
            id: "name",
            header: t("consoleKit.name"),
            cell: (r) => label(r.id),
            sortable: true,
          },
          {
            id: "status",
            header: t("consoleKit.status"),
            cell: () => t("consoleKit.pending"),
            sortable: true,
          },
        ]}
        filter={
          count
            ? undefined
            : {
                query,
                onQueryChange: setQuery,
                filters: filters.map((id) => ({
                  id,
                  label: t("consoleKit.pending"),
                })),
                onRemove: (id) => setFilters(filters.filter((f) => f !== id)),
                onClear: () => {
                  setQuery("");
                  setFilters([]);
                },
                resultCount: total,
              }
        }
        pagination={{ page, pageCount: 40, total, onPageChange: setPage }}
        selection={{
          value: selection,
          onChange: setSelection,
          rowLabel: (r) => label(r.id),
          matching: { snapshot, total },
        }}
        visibleColumns={visible}
        onVisibleColumnsChange={setVisible}
        columnOrder={order}
        onColumnOrderChange={setOrder}
        density={density}
        onDensityChange={setDensity}
        rowActions={(r) => (
          <Button variant="secondary" onPress={() => setOpened(r.id)}>
            {label(r.id)}
          </Button>
        )}
      />
      <DetailDrawer
        isOpen={opened !== undefined}
        onClose={() => setOpened(undefined)}
        title={label(opened)}
        pageHref="#record"
      >
        <p>{t("consoleKit.explanation")}</p>
      </DetailDrawer>
    </div>
  );
}
function EditingExample() {
  const [rows, setRows] = useState([
    { id: 1, name: label(1), value: "10" },
    { id: 2, name: label(2), value: "20" },
  ]);
  return (
    <DataTable
      mode="grid"
      caption={t("consoleKit.editHint", {
        enter: "Enter",
        edit: "F2",
        escape: "Escape",
      })}
      rows={rows}
      rowKey={(r) => r.id}
      columns={[
        {
          id: "name",
          header: t("consoleKit.name"),
          cell: (r) => r.name,
          edit: {
            value: (r) => r.name,
            onCommit: (row, name) =>
              setRows(rows.map((r) => (r.id === row.id ? { ...r, name } : r))),
          },
        },
        {
          id: "value",
          header: t("consoleKit.value"),
          cell: (r) => r.value,
          edit: {
            value: (r) => r.value,
            onCommit: (row, value) =>
              setRows(rows.map((r) => (r.id === row.id ? { ...r, value } : r))),
          },
        },
      ]}
    />
  );
}
/** Deliberately local request outcomes, never a fake backend acknowledgement. */
function GridInteractionExample() {
  const [rows, setRows] = useState([
    { id: 1, name: label(1), value: "10" },
    { id: 2, name: label(2), value: "20" },
  ]);
  const [selectionEnabled, setSelectionEnabled] = useState(true);
  const [actionsEnabled, setActionsEnabled] = useState(true);
  const [visible, setVisible] = useState(["name", "value"]);
  const [selection, setSelection] = useState<TableSelection>({
    kind: "keys",
    keys: new Set(),
  });
  const [behavior, setBehavior] = useState("local");
  const [request, setRequest] = useState("");
  const pending = useRef<(() => void) | undefined>(undefined);
  function commit(
    row: (typeof rows)[number],
    column: "name" | "value",
    value: string,
  ) {
    setRequest(`${row.id}:${column}:${value}`);
    const apply = () =>
      setRows((current) =>
        current.map((r) => (r.id === row.id ? { ...r, [column]: value } : r)),
      );
    if (behavior === "reject")
      return Promise.reject(new globalThis.Error("Synthetic rejection"));
    if (behavior === "throw")
      throw new globalThis.Error("Synthetic synchronous rejection");
    if (behavior === "none") return;
    if (behavior === "delay")
      return new Promise<void>((resolve) => {
        pending.current = () => {
          apply();
          resolve();
          pending.current = undefined;
        };
      });
    apply();
  }
  return (
    <div className={s.stack}>
      <Checkbox isSelected={selectionEnabled} onChange={setSelectionEnabled}>
        {t("consoleKit.selectPage")}
      </Checkbox>
      <Checkbox isSelected={actionsEnabled} onChange={setActionsEnabled}>
        {t("table.rowActions")}
      </Checkbox>
      <label>
        {t("consoleKit.status")}
        <select
          value={behavior}
          onChange={(event) => setBehavior(event.target.value)}
        >
          <option value="local">{t("consoleKit.statuses.demo")}</option>
          <option value="delay">{t("consoleKit.pending")}</option>
          <option value="reject">{t("consoleKit.denied")}</option>
          <option value="none">{t("consoleKit.unknown")}</option>
          <option value="throw">{t("table.error")}</option>
        </select>
      </label>
      <Button onPress={() => pending.current?.()}>
        {t("consoleKit.verify")}
      </Button>
      <DataTable<(typeof rows)[number]>
        mode="grid"
        caption={t("consoleKit.editHint", {
          enter: "Enter",
          edit: "F2",
          escape: "Escape",
        })}
        rows={rows}
        rowKey={(r) => r.id}
        visibleColumns={visible}
        onVisibleColumnsChange={setVisible}
        selection={
          selectionEnabled
            ? {
                value: selection,
                onChange: setSelection,
                rowLabel: (r) => r.name,
              }
            : undefined
        }
        columns={(
          [
            { id: "name", header: t("consoleKit.name") },
            { id: "value", header: t("consoleKit.value") },
          ] as const
        ).map(({ id, header }) => ({
          id,
          header,
          cell: (r) => r[id],
          edit: {
            value: (r) => r[id],
            onCommit: (r, value) => commit(r, id, value),
          },
        }))}
        rowActions={
          actionsEnabled
            ? (r) => (
                <div className={s.row}>
                  <Button isDisabled>{t("consoleKit.approve")}</Button>
                  <Button onPress={() => setRequest(`open:${r.id}`)}>
                    {t("consoleKit.openPage")}
                  </Button>
                  <Button isDisabled>{t("consoleKit.decline")}</Button>
                  <Button onPress={() => setRequest(`share:${r.id}`)}>
                    {t("consoleKit.share")}
                  </Button>
                  <a href="#grid-interaction-after">
                    {t("consoleKit.definition")}
                  </a>
                </div>
              )
            : undefined
        }
      />
      <Button id="grid-interaction-after" onPress={() => setRequest("")}>
        {t("consoleKit.clear")}
      </Button>
      <output data-request="">{request}</output>
    </div>
  );
}
function AccessExample() {
  const [kind, setKind] = useState<"platform" | "node" | "hub">("hub");
  const [scope, setScope] = useState<string | null>("hub-1");
  return (
    <div className={s.stack}>
      <ScopePicker
        options={[
          { id: "hub-1", kind: "hub", label: label(1) },
          { id: "node-1", kind: "node", label: label(2) },
        ]}
        kind={kind}
        selectedId={scope}
        onKindChange={(k) => {
          setKind(k);
          setScope(null);
        }}
        onChange={setScope}
        explanation={t("consoleKit.explanation")}
      />
      <PermissionMatrix
        label={t("consoleKit.scope")}
        roles={[
          { id: "reader", label: label(1) },
          { id: "editor", label: label(2) },
        ]}
        permissions={[1, 2].map((n) => ({
          id: `example.read${n}`,
          label: label(n),
          cells: {
            reader: {
              label: t("consoleKit.allowed"),
              explanation: t("consoleKit.explanation"),
            },
            editor: {
              label: t("consoleKit.denied"),
              explanation: t("consoleKit.locked"),
            },
          },
        }))}
      />
      <EffectiveAccess
        timeZone={zone}
        groups={[
          {
            id: "g",
            title: t("consoleKit.scope"),
            entries: [
              {
                id: "e",
                permission: label(),
                grantingRole: label(2),
                stateLabel: t("consoleKit.pending"),
                expiresAt: at,
                explanation: <p>{t("consoleKit.explanation")}</p>,
              },
            ],
          },
        ]}
      />
      <LockedRule
        title={t("consoleKit.scope")}
        explanation={t("consoleKit.explanation")}
        sourceHref="#rule"
      />
    </div>
  );
}
function DecisionsExample() {
  const [reason, setReason] = useState("");
  const [incident, setIncident] = useState("");
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [credential, setCredential] = useState("");
  const [request, setRequest] = useState("");
  const [method, setMethod] = useState<"code" | "password">("code");
  return (
    <div className={s.stack}>
      <StatusLabel status="demo" />
      <DiffViewer
        label={t("consoleKit.changed")}
        fields={["changed", "added", "removed", "unchanged"].map((kind, i) => ({
          id: kind,
          kind: kind as "changed" | "added" | "removed" | "unchanged",
          label: label(i + 1),
          before: kind === "added" ? null : t("consoleKit.pending"),
          after:
            kind === "removed"
              ? null
              : t(
                  kind === "unchanged"
                    ? "consoleKit.pending"
                    : "consoleKit.allowed",
                ),
          effect: t("consoleKit.explanation"),
        }))}
      />
      <ApprovalCard
        title={label()}
        scope={t("consoleKit.hub")}
        requester={label(2)}
        reason={t("consoleKit.synthetic")}
        digest="synthetic-digest-1"
        expiresAt={at}
        timeZone={zone}
        declineReason={reason}
        onDeclineReasonChange={setReason}
        approve={{
          onPress: () => setRequest("unexpected"),
          disabledReason: t("consoleKit.denied"),
        }}
        decline={{ onPress: () => setRequest(t("consoleKit.saved")) }}
      />
      <Button onPress={() => setOpen(true)}>
        {t("consoleKit.typeToConfirm", { value: label() })}
      </Button>
      <TypedConfirmation
        isOpen={open}
        onOpenChange={setOpen}
        title={t("consoleKit.removed")}
        expected={label()}
        value={typed}
        onChange={setTyped}
        confirmLabel={t("consoleKit.removed")}
        onConfirm={() => {
          setRequest(t("consoleKit.saved"));
          setOpen(false);
        }}
      >
        <p>{t("consoleKit.synthetic")}</p>
      </TypedConfirmation>
      <Button
        variant="secondary"
        onPress={() => setMethod(method === "code" ? "password" : "code")}
      >
        {t(method === "code" ? "consoleKit.password" : "consoleKit.code")}
      </Button>
      <StepUpPrompt
        method={method}
        value={credential}
        onChange={setCredential}
        status="idle"
        onSubmit={() => setRequest(t("consoleKit.saved"))}
        onPasskey={() => setRequest(t("consoleKit.saved"))}
        onCancel={() => setCredential("")}
      />
      <KillSwitchControl
        label={t("consoleKit.release")}
        stateLabel={t("consoleKit.pending")}
        engaged
        reason={reason}
        onReasonChange={setReason}
        incident={incident}
        onIncidentChange={setIncident}
        onEngage={() => setRequest(t("consoleKit.saved"))}
        onRequestRelease={() => setRequest(t("consoleKit.saved"))}
      />
      <p role="status">{request}</p>
    </div>
  );
}
function ActivityExample() {
  const [opened, setOpened] = useState("");
  return (
    <div className={s.stack}>
      <AuditTrail
        label={t("consoleKit.auditNote")}
        timeZone={zone}
        entries={[
          {
            id: "a",
            at,
            actorRole: label(),
            action: t("consoleKit.changed"),
            reason: t("consoleKit.synthetic"),
            digest: <code>synthetic-digest-1</code>,
          },
        ]}
      />
      <RunHistory
        label={t("consoleKit.dryRun")}
        timeZone={zone}
        runs={[
          {
            id: "r",
            label: label(),
            at,
            stateLabel: t("consoleKit.pending"),
            dryRun: true,
            outcomeUnknown: true,
            steps: [
              { id: "s", label: label(2), stateLabel: t("consoleKit.pending") },
            ],
          },
        ]}
      />
      <InboxList
        label={t("consoleKit.pending")}
        timeZone={zone}
        items={[
          {
            id: "i",
            title: label(),
            href: "#work-item",
            kindLabel: t("consoleKit.changed"),
            stateLabel: t("consoleKit.pending"),
            reasonForAssignment: t("consoleKit.explanation"),
            expiresAt: at,
          },
        ]}
      />
      <CalendarAgenda
        label={t("consoleKit.pending")}
        month="2026-11"
        timeZone={zone}
        events={[
          {
            id: "e",
            title: label(),
            startsAt: at,
            stateLabel: t("consoleKit.pending"),
            onOpen: () => setOpened(label()),
          },
        ]}
      />
      <MetricChart
        label={t("consoleKit.definition")}
        period={new Intl.DateTimeFormat(intlTag(), {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(at))}
        definitionHref="#definition"
        points={[
          { id: "1", label: label(), value: { kind: "value", value: 120 } },
          {
            id: "2",
            label: label(2),
            value: { kind: "suppressed", below: 10 },
          },
        ]}
      />
      <BudgetMeter
        label={t("consoleKit.value")}
        used="10.05"
        limit="100.00"
        fraction={0.1005}
        currency="USD"
      />
      <MarginCell amount="-2.50" negative currency="USD" />
      <NetworkMap
        label={t("consoleKit.hub")}
        hubs={[
          {
            id: "us",
            label: label(),
            territories: ["US-CA"],
            territoryLabel: t("consoleKit.hub"),
            stateLabel: t("consoleKit.pending"),
            peeringLabel: t("consoleKit.denied"),
            longitude: -117,
            latitude: 33,
          },
          {
            id: "ge",
            label: label(2),
            territories: ["GE"],
            territoryLabel: t("consoleKit.hub"),
            stateLabel: t("consoleKit.pending"),
            peeringLabel: t("consoleKit.denied"),
            longitude: 44,
            latitude: 42,
          },
          {
            id: "restricted",
            label: "RESTRICTED_FIXTURE_MUST_NOT_RENDER",
            territories: ["UA-43"],
            territoryLabel: "",
            stateLabel: "",
            peeringLabel: "",
            longitude: 34,
            latitude: 45,
          },
        ]}
        onOpen={setOpened}
      />
      <p role="status">{opened}</p>
    </div>
  );
}
function NavigationExample() {
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const [help, setHelp] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState("");
  const [drawer, setDrawer] = useState(false);
  return (
    <div className={s.stack}>
      <div className={s.row}>
        <Button onPress={() => setPalette(true)}>
          {t("consoleKit.commands")}
        </Button>
        <Button onPress={() => setHelp(true)}>
          {t("consoleKit.shortcuts")}
        </Button>
        <Button onPress={() => setDrawer(true)}>
          {t("consoleKit.openPage")}
        </Button>
      </div>
      <InlineHelp label={t("consoleKit.rule")}>
        <p>{t("consoleKit.explanation")}</p>
      </InlineHelp>
      <CommandPalette
        isOpen={palette}
        onOpenChange={setPalette}
        query={query}
        onQueryChange={setQuery}
        commands={[1, 2, 3].map((n) => ({
          id: String(n),
          label: label(n),
          group: t(n === 3 ? "consoleKit.scope" : "consoleKit.commands"),
          shortcut: n === 1 ? "Ctrl+K" : undefined,
          onSelect: () => setSelected(label(n)),
        }))}
      />
      <KeyboardShortcuts
        isOpen={help}
        onOpenChange={setHelp}
        shortcuts={[
          {
            id: "palette",
            keys: "Ctrl+K / Cmd+K",
            description: t("consoleKit.commands"),
          },
        ]}
        singleKeysEnabled={enabled}
        onSingleKeysChange={setEnabled}
      />
      <DetailDrawer
        isOpen={drawer}
        onClose={() => setDrawer(false)}
        title={label()}
        pageHref="#record"
      >
        <p>{t("consoleKit.explanation")}</p>
      </DetailDrawer>
      <p role="status">{selected}</p>
    </div>
  );
}
export const Records: Story = { render: () => <RecordsExample /> };
export const EditableGrid: Story = { render: () => <EditingExample /> };
export const GridInteractions: Story = {
  render: () => <GridInteractionExample />,
};
export const Access: Story = { render: () => <AccessExample /> };
export const Decisions: Story = { render: () => <DecisionsExample /> };
export const Activity: Story = { render: () => <ActivityExample /> };
export const Navigation: Story = { render: () => <NavigationExample /> };
export const Loading: Story = {
  render: () => (
    <DataTable
      state="loading"
      caption={t("consoleKit.synthetic")}
      rows={[]}
      columns={[]}
      rowKey={() => ""}
    />
  ),
};
export const Empty: Story = {
  render: () => (
    <DataTable
      caption={t("consoleKit.synthetic")}
      rows={[]}
      columns={[]}
      rowKey={() => ""}
    />
  ),
};
export const Error: Story = {
  render: () => (
    <DataTable
      state="error"
      caption={t("consoleKit.synthetic")}
      rows={[]}
      columns={[]}
      rowKey={() => ""}
    />
  ),
};
