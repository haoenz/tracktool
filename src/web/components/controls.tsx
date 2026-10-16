// Application-level compositions of the local shadcn/ui primitives.
import {
  useId,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { cn } from "../lib/utils.js";
import { Button as BaseButton } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Checkbox as BaseCheckbox } from "./ui/checkbox.js";
import {
  Alert as BaseAlert,
  AlertTitle,
  AlertDescription,
} from "./ui/alert.js";
import {
  Card as BaseCard,
  CardHeader,
  CardTitle,
  CardContent,
  CardAction,
} from "./ui/card.js";
import { Badge } from "./ui/badge.js";
import { Progress as BaseProgress } from "./ui/progress.js";
import {
  Tabs as BaseTabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "./ui/tabs.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog.js";
import {
  Select as BaseSelect,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select.js";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover.js";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "./ui/command.js";
import {
  Table as BaseTable,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "./ui/table.js";
import {
  RadioGroup as BaseRadioGroup,
  RadioGroupItem,
} from "./ui/radio-group.js";
export { Input } from "./ui/input.js";
export { Textarea } from "./ui/textarea.js";
export { Switch } from "./ui/switch.js";

export function Button({
  loading,
  block,
  variant = "outline",
  children,
  disabled,
  className,
  ...props
}: ComponentProps<typeof BaseButton> & { loading?: boolean; block?: boolean }) {
  return (
    <BaseButton
      type="button"
      variant={variant}
      className={cn(block && "w-full", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircleIcon className="size-4 animate-spin" />}
      {children}
    </BaseButton>
  );
}
export function Spin({ decorative = false }: { decorative?: boolean }) {
  return (
    <span
      role={decorative ? undefined : "status"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : "加载中"}
      className="inline-flex items-center gap-2 text-muted-foreground"
    >
      <LoaderCircleIcon className="size-4 animate-spin" />
      <span className="sr-only">加载中</span>
    </span>
  );
}
export function Space({
  children,
  className,
  wrap,
}: {
  children?: ReactNode;
  className?: string;
  wrap?: boolean;
}) {
  return (
    <div
      className={cn(
        "ui-space flex items-center gap-2",
        wrap && "flex-wrap",
        className,
      )}
    >
      {children}
    </div>
  );
}
export function Checkbox({
  children,
  id,
  className,
  onCheckedChange,
  ...props
}: Omit<ComponentProps<typeof BaseCheckbox>, "onCheckedChange"> & {
  onCheckedChange?: (checked: boolean) => void;
}) {
  const generated = useId();
  return (
    <span
      className={cn(
        "ui-checkbox inline-flex items-center gap-2 align-middle",
        className,
      )}
    >
      <BaseCheckbox
        id={id ?? generated}
        onCheckedChange={(value) => onCheckedChange?.(value === true)}
        {...props}
      />
      {children && (
        <label htmlFor={id ?? generated} className="cursor-pointer text-sm">
          {children}
        </label>
      )}
    </span>
  );
}
export function InputNumber({
  value,
  onChange,
  min,
  max,
  precision,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "min" | "max"> & {
  value?: number | null;
  onChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  precision?: number;
}) {
  return (
    <Input
      {...props}
      className={cn("ui-number", className)}
      type="number"
      min={min}
      max={max}
      step={props.step ?? "any"}
      value={value ?? ""}
      onChange={(e) => {
        if (!e.target.value) {
          onChange?.(null);
          return;
        }
        let next = e.target.valueAsNumber;
        if (!Number.isFinite(next)) return;
        if (min !== undefined) next = Math.max(min, next);
        if (max !== undefined) next = Math.min(max, next);
        if (precision !== undefined) next = Number(next.toFixed(precision));
        onChange?.(next);
      }}
    />
  );
}

type Option = {
  value: string | number | undefined;
  label: ReactNode;
  disabled?: boolean;
};
type ChoiceProps<T> = {
  value?: T;
  options?: Option[];
  onChange?: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  searchable?: boolean;
  clearable?: boolean;
  multiple?: boolean;
  maxCount?: number;
  id?: string;
  "aria-label"?: string;
  style?: CSSProperties;
  className?: string;
};
export function Select<T extends string | number | undefined | string[]>({
  value,
  options = [],
  onChange,
  placeholder = "请选择",
  disabled,
  loading,
  searchable,
  clearable,
  multiple,
  maxCount,
  ...props
}: ChoiceProps<T>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const values: (string | number | undefined)[] = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  const selected = options.filter((o) => values.includes(o.value));
  function choose(option: Option) {
    if (multiple) {
      const old = (Array.isArray(value) ? value : []) as string[];
      const v = String(option.value);
      if (!old.includes(v) && maxCount !== undefined && old.length >= maxCount)
        return;
      onChange?.(
        (old.includes(v) ? old.filter((x) => x !== v) : [...old, v]) as T,
      );
    } else {
      onChange?.(option.value as T);
      setOpen(false);
    }
  }
  if (searchable || multiple)
    return (
      <div
        className={cn("ui-select min-w-0", props.className)}
        style={props.style}
      >
        <Popover
          open={open}
          onOpenChange={(next) => {
            setSearch("");
            setOpen(next);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              ref={trigger}
              id={props.id}
              role="combobox"
              aria-label={props["aria-label"]}
              aria-expanded={open}
              disabled={disabled}
              className="w-full min-w-0 justify-between font-normal"
            >
              <span className="truncate">
                {multiple
                  ? values.length
                    ? `已选择 ${values.length} 项`
                    : placeholder
                  : (selected[0]?.label ?? placeholder)}
              </span>
              {loading ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[var(--radix-popover-trigger-width)] min-w-48 max-w-[calc(100vw-2rem)] p-0"
          >
            <Command>
              <CommandInput
                value={search}
                onValueChange={setSearch}
                aria-label={`搜索${props["aria-label"] ?? "选项"}`}
                placeholder="搜索…"
              />
              <CommandList
                aria-label={props["aria-label"]}
                aria-multiselectable={multiple || undefined}
              >
                <CommandEmpty>没有匹配的选项</CommandEmpty>
                {clearable && (
                  <CommandItem
                    value="清除选择"
                    onSelect={() => {
                      onChange?.(undefined as T);
                      setOpen(false);
                    }}
                  >
                    清除选择
                  </CommandItem>
                )}
                {options.map((o, i) => (
                  <CommandItem
                    key={`${o.value}:${i}`}
                    value={`${String(o.label)} ${o.value}`}
                    disabled={
                      o.disabled ||
                      (multiple &&
                        !values.includes(o.value) &&
                        maxCount !== undefined &&
                        values.length >= maxCount)
                    }
                    onSelect={() => choose(o)}
                  >
                    <CheckIcon
                      className={cn(
                        "size-4",
                        !values.includes(o.value) && "invisible",
                      )}
                    />
                    <span className="break-all">{o.label}</span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {multiple && values.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {values.slice(0, 3).map((v) => (
              <Badge key={v} variant="secondary" className="max-w-full gap-1">
                <span className="truncate">
                  {options.find((o) => o.value === v)?.label ?? v}
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${v}`}
                  disabled={disabled}
                  className="shrink-0 rounded-sm p-1 hover:bg-muted focus-visible:ring-2"
                  onClick={() => onChange?.(values.filter((x) => x !== v) as T)}
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            ))}
            {values.length > 3 && (
              <Badge variant="secondary">另 {values.length - 3} 项</Badge>
            )}
          </div>
        )}
      </div>
    );
  // Use indices so empty strings and numeric values remain valid choices.
  const index = options.findIndex((o) => o.value === value);
  return (
    <BaseSelect
      value={index < 0 ? "" : `option-${index}`}
      onValueChange={(key) =>
        onChange?.(
          (key === "clear"
            ? undefined
            : options[Number(key.slice(7))]?.value) as T,
        )
      }
      disabled={disabled}
    >
      <SelectTrigger
        {...props}
        className={cn("ui-select w-full min-w-0", props.className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {clearable && <SelectItem value="clear">清除选择</SelectItem>}
        {options.map((o, i) => (
          <SelectItem
            key={`${o.value}:${i}`}
            value={`option-${i}`}
            disabled={o.disabled}
          >
            {o.label}
          </SelectItem>
        ))}
        {!options.length && (
          <div className="p-3 text-sm text-muted-foreground">暂无选项</div>
        )}
      </SelectContent>
    </BaseSelect>
  );
}
export function Alert({
  type = "info",
  title,
  description,
  action,
  closable,
  onClose,
}: {
  type?: "error" | "warning" | "info" | "success";
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  closable?: boolean;
  onClose?: () => void;
}) {
  return (
    <BaseAlert
      variant={type === "error" ? "destructive" : "default"}
      className={cn(
        "ui-alert",
        type === "warning" && "border-amber-300 bg-amber-50 text-amber-950",
        type === "info" && "bg-muted/40",
        closable && "pr-10",
      )}
    >
      <AlertTitle>{title}</AlertTitle>
      {description && <AlertDescription>{description}</AlertDescription>}
      {action && <div className="mt-2">{action}</div>}
      {closable && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="关闭提示"
          className="absolute right-1 top-1"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      )}
    </BaseAlert>
  );
}
export function Card({
  title,
  extra,
  children,
  className,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <BaseCard className={cn("ui-card gap-3 py-4 shadow-xs", className)}>
      {(title || extra) && (
        <CardHeader className="px-4">
          <CardTitle className="text-sm leading-relaxed">{title}</CardTitle>
          {extra && <CardAction>{extra}</CardAction>}
        </CardHeader>
      )}
      <CardContent className="px-4">{children}</CardContent>
    </BaseCard>
  );
}
export function Tag({
  color,
  children,
}: {
  color?: string;
  children?: ReactNode;
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        color === "green" && "bg-emerald-50 text-emerald-800",
        color === "red" && "bg-red-50 text-red-800",
        color === "blue" && "bg-blue-50 text-blue-800",
      )}
    >
      {children}
    </Badge>
  );
}
export function Progress({
  percent = 0,
  format,
  status,
}: {
  percent?: number;
  format?: () => ReactNode;
  status?: string;
}) {
  return (
    <div className="my-3 flex items-center gap-3">
      <BaseProgress
        value={percent}
        aria-label="处理进度"
        className={cn("h-2", status === "active" && "animate-pulse")}
      />
      <span className="shrink-0 text-xs text-muted-foreground">
        {format ? format() : `${percent}%`}
      </span>
    </div>
  );
}
export function Descriptions({
  items,
}: {
  items: { key: string; label: ReactNode; children: ReactNode }[];
}) {
  return (
    <dl className="ui-descriptions grid gap-3 text-sm">
      {items.map((i) => (
        <div key={i.key} className="grid gap-1">
          <dt className="text-muted-foreground">{i.label}</dt>
          <dd className="m-0 whitespace-pre-wrap break-all">{i.children}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Tabs({
  activeKey,
  onChange,
  items,
}: {
  activeKey: string;
  onChange: (key: string) => void;
  items: { key: string; label: ReactNode; children: ReactNode }[];
}) {
  const [visited, setVisited] = useState(() => new Set([activeKey]));
  return (
    <BaseTabs
      value={activeKey}
      onValueChange={(key) => {
        setVisited((old) => new Set([...old, key]));
        onChange(key);
      }}
    >
      <TabsList className="w-full">
        {items.map((i) => (
          <TabsTrigger key={i.key} value={i.key}>
            {i.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {items
        .filter((i) => visited.has(i.key) || i.key === activeKey)
        .map((i) => (
          <TabsContent
            key={i.key}
            value={i.key}
            forceMount
            hidden={i.key !== activeKey}
          >
            {i.children}
          </TabsContent>
        ))}
    </BaseTabs>
  );
}
export function Modal({
  title,
  open,
  onCancel,
  onOk,
  confirmLoading,
  okButtonProps,
  footer,
  children,
  closable = true,
  maskClosable = true,
}: {
  title: string;
  open: boolean;
  onCancel: () => void;
  onOk?: () => void;
  confirmLoading?: boolean;
  okButtonProps?: { disabled?: boolean };
  footer?: ReactNode;
  children?: ReactNode;
  closable?: boolean;
  maskClosable?: boolean;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && closable) onCancel();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={closable}
        className="max-h-[85dvh] overflow-y-auto"
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement as HTMLElement;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          returnFocus.current?.focus();
        }}
        onPointerDownOutside={(e) => {
          if (!maskClosable) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (!closable) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">{children}</div>
        <DialogFooter className="flex-wrap">
          {footer ?? (
            <>
              <Button onClick={onCancel} disabled={confirmLoading}>
                取消
              </Button>
              <Button
                variant="default"
                onClick={onOk}
                loading={confirmLoading}
                disabled={okButtonProps?.disabled}
              >
                确定
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function Pagination({
  current,
  pageSize,
  total,
  onChange,
  hideOnSinglePage,
}: {
  current: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  hideOnSinglePage?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (hideOnSinglePage && pages === 1) return null;
  return (
    <nav aria-label="分页" className="my-3 flex items-center justify-end gap-2">
      <Button
        size="icon-sm"
        aria-label="上一页"
        disabled={current <= 1}
        onClick={() => onChange(current - 1)}
      >
        <ChevronLeftIcon />
      </Button>
      <span className="text-xs tabular-nums text-muted-foreground">
        {current} / {pages}
      </span>
      <Button
        size="icon-sm"
        aria-label="下一页"
        disabled={current >= pages}
        onClick={() => onChange(current + 1)}
      >
        <ChevronRightIcon />
      </Button>
    </nav>
  );
}
export function Table<T>({
  dataSource,
  columns,
  rowKey,
  pagination,
  tableLayout,
}: {
  dataSource: T[];
  columns: {
    title: string;
    dataIndex?: keyof T;
    width?: string;
    render?: (value: never, row: T) => ReactNode;
  }[];
  rowKey: keyof T | ((row: T) => string);
  pagination: { pageSize: number };
  tableLayout?: "fixed";
}) {
  const [page, setPage] = useState(1);
  const current = Math.min(
    page,
    Math.max(1, Math.ceil(dataSource.length / pagination.pageSize)),
  );
  return (
    <div className="ui-data-table min-w-0">
      <BaseTable style={{ tableLayout }}>
        <TableHeader>
          <TableRow>
            {columns.map((c, i) => (
              <TableHead key={i} style={{ width: c.width }}>
                {c.title}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {dataSource
            .slice(
              (current - 1) * pagination.pageSize,
              current * pagination.pageSize,
            )
            .map((row) => (
              <TableRow
                key={
                  typeof rowKey === "function"
                    ? rowKey(row)
                    : String(row[rowKey])
                }
              >
                {columns.map((c, i) => (
                  <TableCell key={i} className="whitespace-normal break-words">
                    {c.render
                      ? c.render(
                          (c.dataIndex ? row[c.dataIndex] : undefined) as never,
                          row,
                        )
                      : String(c.dataIndex ? (row[c.dataIndex] ?? "") : "")}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {!dataSource.length && (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-24 text-center text-muted-foreground"
              >
                暂无数据
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </BaseTable>
      <Pagination
        current={current}
        pageSize={pagination.pageSize}
        total={dataSource.length}
        onChange={setPage}
        hideOnSinglePage
      />
    </div>
  );
}

export function RadioGroup({
  value,
  onValueChange,
  options,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <BaseRadioGroup
      value={value}
      onValueChange={onValueChange}
      className="mb-3 flex flex-wrap gap-4"
    >
      {options.map((o) => (
        <div key={o.value} className="flex items-center gap-2">
          <RadioGroupItem id={`${id}-${o.value}`} value={o.value} />
          <label htmlFor={`${id}-${o.value}`} className="text-sm">
            {o.label}
          </label>
        </div>
      ))}
    </BaseRadioGroup>
  );
}
