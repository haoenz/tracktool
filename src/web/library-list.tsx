import { Fragment, useMemo, type ComponentProps } from "react";
import type { OverviewEntry } from "../shared/overview.js";
import type { OverviewVisibility } from "./overview-layer.js";
import { Button, Checkbox, Pagination } from "./components/controls.js";
import { PanelLoading } from "./components/panel-loading.js";
import { LibraryToolbar, type ListVisibility } from "./library-toolbar.js";
import { TrackListRow } from "./track-list-row.js";

export function LibraryList({
  toolbar,
  entries,
  matchingEntries,
  visibilityPending,
  visibilityError,
  selectedId,
  visibility,
  batch,
  batchSelecting,
  loading,
  fetching,
  error,
  onRetry,
  total,
  offset,
  onOffset,
  onOpen,
  onToggleBatch,
  onToggleVisible,
  onSelectPage,
  exportDisabled,
  onExport,
}: {
  toolbar: Omit<
    ComponentProps<typeof LibraryToolbar>,
    | "batchAllSelected"
    | "batchMixed"
    | "visibility"
    | "visibilityLabel"
    | "onSelectAll"
  > & {
    onSelectAll: (checked: boolean) => void;
  };
  entries: OverviewEntry[];
  matchingEntries?: OverviewEntry[];
  visibilityPending: boolean;
  visibilityError: boolean;
  selectedId: string;
  visibility: OverviewVisibility;
  batch: Record<string, string>;
  batchSelecting: boolean;
  loading: boolean;
  fetching: boolean;
  error?: string;
  onRetry: () => void;
  total?: number;
  offset: number;
  onOffset: (offset: number) => void;
  onOpen: (entry: OverviewEntry) => void;
  onToggleBatch: (entry: OverviewEntry) => void;
  onToggleVisible: (entry: OverviewEntry, checked: boolean) => void;
  onSelectPage: (checked: boolean) => void;
  exportDisabled: boolean;
  onExport: () => void;
}) {
  const {
    rows,
    selectedOnPage,
    pageSelected,
    batchCount,
    listVisibility,
    visibilityLabel,
    batchAllSelected,
    batchMixed,
  } = useMemo(() => {
    const rows = entries.map((entry, index) => ({
      entry,
      month:
        index === 0 ||
        entry.date.slice(0, 7) !== entries[index - 1]!.date.slice(0, 7)
          ? entry.date.slice(0, 7) || "日期未知"
          : undefined,
      visible:
        visibility.all !== Object.hasOwn(visibility.exceptions, entry.id),
      checked: Object.hasOwn(batch, entry.id),
    }));
    const selectedOnPage = rows.filter((row) => row.checked).length;
    const hasExceptions = Object.keys(visibility.exceptions).length > 0;
    const needsMatchingEntries = (total ?? 0) > entries.length;
    const visibilityEntries =
      hasExceptions && needsMatchingEntries ? matchingEntries : entries;
    const visibleCount =
      visibilityEntries?.filter(
        (entry) =>
          visibility.all !== Object.hasOwn(visibility.exceptions, entry.id),
      ).length ?? 0;
    const listVisibility: ListVisibility =
      visibilityPending ||
      (hasExceptions && needsMatchingEntries && visibilityError)
        ? undefined
        : !hasExceptions
          ? visibility.all
            ? "all"
            : "none"
          : !visibleCount
            ? "none"
            : visibleCount === visibilityEntries?.length
              ? "all"
              : "mixed";
    const batchEntries = needsMatchingEntries ? matchingEntries : entries;
    const selectedInFilter =
      batchEntries?.filter((entry) => Object.hasOwn(batch, entry.id)).length ??
      0;
    const batchAllSelected =
      !!batchEntries?.length && selectedInFilter === batchEntries.length;
    return {
      listVisibility,
      visibilityLabel:
        listVisibility === "all"
          ? "全部显示"
          : listVisibility === "none"
            ? "全部隐藏"
            : listVisibility === "mixed"
              ? "部分显示"
              : "正在确认显示状态",
      batchAllSelected,
      batchMixed: selectedInFilter > 0 && !batchAllSelected,
      rows,
      selectedOnPage,
      pageSelected: rows.length > 0 && selectedOnPage === rows.length,
      batchCount: Object.keys(batch).length,
    };
  }, [
    entries,
    matchingEntries,
    total,
    visibility,
    visibilityPending,
    visibilityError,
    batch,
  ]);
  return (
    <>
      <LibraryToolbar
        {...toolbar}
        batchAllSelected={batchAllSelected}
        batchMixed={batchMixed}
        visibility={listVisibility}
        visibilityLabel={visibilityLabel}
        onSelectAll={() => toolbar.onSelectAll(!batchAllSelected)}
      />
      <div className="map-track-list" aria-busy={loading}>
        {loading ? (
          <PanelLoading>正在读取轨迹列表…</PanelLoading>
        ) : total === 0 ? (
          <div className="track-list-status" role="status">
            无匹配
          </div>
        ) : null}
        {!loading &&
          rows.map(({ entry, month, visible, checked }) => (
            <Fragment key={entry.id}>
              {month && <h4 className="month-heading">{month}</h4>}
              <TrackListRow
                entry={entry}
                selected={selectedId === entry.id}
                visible={visible}
                batchMode={toolbar.batchMode}
                batchSelecting={batchSelecting}
                checked={checked}
                onOpen={() => onOpen(entry)}
                onToggleBatch={() => onToggleBatch(entry)}
                onToggleVisible={() => onToggleVisible(entry, !visible)}
              />
            </Fragment>
          ))}
      </div>
      {error && (
        <div role="alert">
          {error}
          <Button onClick={onRetry}>重试列表</Button>
        </div>
      )}
      {(toolbar.batchMode || (total ?? 0) > 50) && (
        <div className="track-list-footer">
          {toolbar.batchMode && (
            <div className="page-selection" role="region" aria-label="多选范围">
              <Checkbox
                checked={
                  pageSelected
                    ? true
                    : selectedOnPage > 0
                      ? "indeterminate"
                      : false
                }
                disabled={!entries.length || fetching || batchSelecting}
                onCheckedChange={(checked) => onSelectPage(!!checked)}
              >
                全选本页
              </Checkbox>
            </div>
          )}
          <Pagination
            current={Math.floor(offset / 50) + 1}
            pageSize={50}
            total={total ?? 0}
            onChange={(page) => onOffset((page - 1) * 50)}
            showQuickJumper
            hideOnSinglePage
          />
        </div>
      )}
      {toolbar.batchMode && batchCount > 0 && (
        <div
          className="batch-action-bar"
          role="region"
          aria-label="所选轨迹操作"
        >
          <span aria-live="polite">已选 {batchCount} 条</span>
          <Button
            variant="default"
            disabled={exportDisabled}
            onClick={onExport}
          >
            导出
          </Button>
        </div>
      )}
    </>
  );
}
