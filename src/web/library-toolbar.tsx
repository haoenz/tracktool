import { useState } from "react";
import {
  ArrowDownWideNarrow,
  Eye,
  EyeOff,
  Funnel,
  ListChecks,
  LoaderCircle,
  Square,
  SquareCheck,
  SquareMinus,
} from "lucide-react";
import { Button, Input, RadioGroup } from "./components/controls.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.js";

export type ListVisibility = "all" | "none" | "mixed" | undefined;

/** Visibility, filter, search, sort and batch entry points for the library list. */
export function LibraryToolbar({
  batchMode,
  batchAllSelected,
  batchMixed,
  batchBusy,
  batchDisabled,
  onSelectAll,
  visibility,
  visibilityBusy,
  visibilityDisabled,
  visibilityLabel,
  onToggleVisibility,
  filtersApplied,
  onOpenFilters,
  filter,
  onFilter,
  sort,
  onSort,
  onToggleBatch,
}: {
  batchMode: boolean;
  batchAllSelected: boolean;
  batchMixed: boolean;
  batchBusy: boolean;
  batchDisabled: boolean;
  onSelectAll: () => void;
  visibility: ListVisibility;
  visibilityBusy: boolean;
  visibilityDisabled: boolean;
  visibilityLabel: string;
  onToggleVisibility: () => void;
  filtersApplied: boolean;
  onOpenFilters: () => void;
  filter: string;
  onFilter: (value: string) => void;
  sort: string;
  onSort: (sort: string) => void;
  onToggleBatch: () => void;
}) {
  const [sortOpen, setSortOpen] = useState(false);
  return (
    <div className="list-visibility-toolbar">
      {batchMode ? (
        <Button
          variant="ghost"
          className="list-visibility-button"
          aria-label={batchAllSelected ? "清空全部勾选" : "勾选全部筛选结果"}
          title={
            batchAllSelected
              ? "取消当前筛选的全部勾选（包含所有分页）"
              : "勾选当前筛选的全部轨迹（包含所有分页）"
          }
          aria-pressed={batchMixed ? "mixed" : batchAllSelected}
          aria-busy={batchBusy || undefined}
          disabled={batchDisabled}
          onClick={onSelectAll}
        >
          {batchAllSelected ? (
            <SquareCheck size={20} aria-hidden="true" />
          ) : batchMixed ? (
            <SquareMinus size={20} aria-hidden="true" />
          ) : (
            <Square size={20} aria-hidden="true" />
          )}
          {batchBusy && (
            <span className="visibility-loading-mask" aria-hidden="true">
              <LoaderCircle size={20} className="animate-spin" />
            </span>
          )}
        </Button>
      ) : (
        <Button
          variant="ghost"
          aria-label="切换当前列表可见性"
          className="list-visibility-button"
          title={`${visibilityLabel}：点击${visibility === "none" ? "全部显示" : "全部隐藏"}（包含所有分页）`}
          aria-pressed={
            visibility === undefined
              ? undefined
              : visibility === "mixed"
                ? "mixed"
                : visibility === "all"
          }
          aria-busy={visibilityBusy || undefined}
          data-visibility={visibility ?? "pending"}
          disabled={visibilityDisabled}
          onClick={onToggleVisibility}
        >
          {visibility === "none" ? (
            <EyeOff size={20} aria-hidden="true" />
          ) : (
            <Eye size={20} aria-hidden="true" />
          )}
          {visibilityBusy && (
            <span className="visibility-loading-mask" aria-hidden="true">
              <LoaderCircle size={20} className="animate-spin" />
            </span>
          )}
        </Button>
      )}
      <Button
        className="list-filter-button"
        variant={filtersApplied ? "secondary" : "ghost"}
        aria-label="筛选"
        aria-haspopup="dialog"
        title={filtersApplied ? "筛选：已设置" : "筛选"}
        onClick={onOpenFilters}
      >
        <Funnel size={20} aria-hidden="true" />
        {filtersApplied && (
          <span className="filter-indicator" aria-label="已设置" />
        )}
      </Button>
      <Input
        id="filter"
        aria-label="筛选轨迹"
        placeholder="搜索轨迹"
        value={filter}
        onChange={(event) => onFilter(event.target.value)}
      />
      <Popover open={sortOpen} onOpenChange={setSortOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={sort === "date-desc" ? "ghost" : "secondary"}
            aria-label="排序"
            title="排序"
          >
            <ArrowDownWideNarrow size={20} aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="list-sort-menu"
          aria-label="排序"
        >
          <p className="mb-3 font-medium">排序</p>
          <RadioGroup
            value={sort}
            onValueChange={(value) => {
              onSort(value);
              setSortOpen(false);
            }}
            options={[
              { value: "date-desc", label: "日期从新到旧" },
              { value: "date-asc", label: "日期从旧到新" },
            ]}
          />
        </PopoverContent>
      </Popover>
      <Button
        variant={batchMode ? "secondary" : "ghost"}
        aria-label="批量操作"
        title="批量操作"
        aria-pressed={batchMode}
        onClick={onToggleBatch}
      >
        <ListChecks size={20} aria-hidden="true" />
      </Button>
    </div>
  );
}
